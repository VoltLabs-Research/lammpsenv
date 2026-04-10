import { ResolvedSimulationSpec, SimulationSpec } from '@/domain/simulation/SimulationSpec';
import { RunStore } from '@/ports/RunStore';
import Run from '@/domain/simulation/Run';
import crypto from 'node:crypto';
import EnsureImage from '../images/EnsureImage';
import { PreparedWorkspace, WorkspacePreparerPort } from '@/ports/WorkspacePreparerPort';
import { ContainerHandle, ContainerManagerPort } from '@/ports/ContainerManagerPort';
import { LogStreamerPort, LogStreamHandle } from '@/ports/LogStreamerPort';
import { FileWatcher, FileWatchHandle } from '@/ports/FileWatcher';
import { EventBusPort } from '@/ports/EventBusPort';
import { RuntimeEventMap } from '@/domain/observability/EventMap';
import { Logger } from '@/ports/Logger';
import RunHandle from '@/domain/simulation/RunHandle';
import LammpsOutputInterpreter from './LammpsOutputInterpreter';
import DumpFrameTracker from './DumpFrameTracker';
import StopSimulation from './StopSimulation';

export default class StartSimulation{
    constructor(
        private readonly ensureImage: EnsureImage,
        private readonly workspacePreparer: WorkspacePreparerPort,
        private readonly containerManager: ContainerManagerPort,
        private readonly logStreamer: LogStreamerPort,
        private readonly fileWatcher: FileWatcher,
        private readonly runStore: RunStore,
        private readonly eventBus: EventBusPort<RuntimeEventMap>,
        private readonly stopSimulation: StopSimulation,
        private readonly logger: Logger
    ){}

    async execute(spec: SimulationSpec): Promise<RunHandle>{
        const resolvedSpec = this.resolveSpec(spec);
        this.validateInputScript(resolvedSpec);
        
        let imageTag = (typeof resolvedSpec.image === 'string')
            ? resolvedSpec.image
            : (await this.ensureImage.execute(resolvedSpec.image)).tag
        
        const run = new Run(crypto.randomUUID(), imageTag, resolvedSpec.outputDir);
        run.markPreparing();
        await this.runStore.save(run);

        this.eventBus.emit('simulation:created', {
            runId: run.id,
            imageTag,
            outputDir: resolvedSpec.outputDir,
            snapshot: run.snapshot()
        });

        this.emitState(run);

        let workspace: PreparedWorkspace | null = null;
        let container: ContainerHandle | null = null;
        let logStream: LogStreamHandle | null = null;
        let watchHandle: FileWatchHandle | null = null;

        try{
            workspace = await this.workspacePreparer.prepare(run.id, resolvedSpec);
            const command = this.buildCommand(resolvedSpec, workspace.mainInputContainerPath);

            container = await this.containerManager.create({
                imageTag,
                name: resolvedSpec.execution.containerName ?? `lammps-${run.id}`,
                command,
                workingDir: resolvedSpec.execution.workingDir,
                shell: resolvedSpec.execution.shell,
                binds: [
                    `${workspace.inputDir}:/workspace/input:ro`,
                    `${workspace.outputDir}:/workspace/output`,
                ],
                env: resolvedSpec.env,
                labels: resolvedSpec.labels,
                cpus: resolvedSpec.resources.cpus,
                memory: resolvedSpec.resources.memory,
                gpus: resolvedSpec.resources.gpus
            });

            run.attachContainer(container.id);
            run.markStarting();
            await this.runStore.update(run);
            this.emitState(run);

            const outputInterpreter = new LammpsOutputInterpreter();
            const dumpTracker = new DumpFrameTracker();

            logStream = await this.logStreamer.stream(container, {
                onStdout: async (line) => {
                    await this.handleStdout(run, line, outputInterpreter);
                },
                onStderr: async (line) => {
                    this.eventBus.emit('simulation:stderr', {
                        runId: run.id,
                        line,
                        snapshot: run.snapshot()
                    });
                },
                onError: async (error) => {
                    await this.handleError(run, error);
                }
            });

            if(resolvedSpec.dumpWatch.enabled){
                watchHandle = await this.fileWatcher.watch(workspace.outputDir, resolvedSpec.dumpWatch.patterns, {
                    onAdd: async (filePath) => {
                        await this.handleDumpFile(run, filePath, dumpTracker, resolvedSpec.dumpWatch.parseTimesteps);
                    },

                    onChange: async (filePath) => {
                        await this.handleDumpFile(run, filePath, dumpTracker, resolvedSpec.dumpWatch.parseTimesteps);
                    },

                    onError: async (error) => {
                        await this.handleError(run, error);
                    }
                });
            }

            await this.containerManager.start(container);
            
            run.markRunning();
            await this.runStore.update(run);

            this.eventBus.emit('simulation:start', {
                runId: run.id,
                imageTag,
                containerId: container.id,
                outputDir: workspace.outputDir,
                snapshot: run.snapshot()
            });

            this.emitState(run);

            const handle = new RunHandle(
                run.id,
                this.eventBus,
                async () => {
                    const current = await this.runStore.get(run.id);
                    return current ? current.snapshot() : null;
                },
                async () => {
                    await this.stopSimulation.execute(run.id, false);
                },
                async () => {
                    await this.stopSimulation.execute(run.id, true);
                }
            );

            void this.monitorCompletion(run, container, resolvedSpec, workspace, logStream, watchHandle);

            return handle;
        }catch(error){
            const message = error instanceof Error ? error.message : String(error);
            run.markFailed(message);
            await this.runStore.update(run);
            this.emitState(run);

            this.eventBus.emit('simulation:error', {
                runId: run.id,
                error: message,
                snapshot: run.snapshot()
            });

            this.eventBus.emit('simulation:end', {
                runId: run.id,
                exitCode: null,
                snapshot: run.snapshot()
            });

            if(logStream){
                await logStream.close();
            }

            if(watchHandle){
                await watchHandle.close();
            }

            if(container && resolvedSpec.cleanup.removeContainer){
                await this.containerManager.remove(container, true);
            }

            if(workspace && resolvedSpec.cleanup.removeWorkspace){
                await this.workspacePreparer.cleanup(workspace);
            }

            throw error;
        }
    }

    private resolveSpec(spec: SimulationSpec): ResolvedSimulationSpec{
        return {
            image: spec.image,
            inputScript: spec.inputScript,
            inputFiles: spec.inputFiles ?? [],
            variables: spec.variables ?? {},
            env: spec.env ?? {},
            labels: spec.labels ?? {},
            resources: spec.resources ?? {},
            execution: {
                binary: spec.execution?.binary ?? 'lmp',
                mpiRanks: spec.execution?.mpiRanks ?? 1,
                extraArgs: [...(spec.execution?.extraArgs ?? [])],
                workingDir: spec.execution?.workingDir ?? '/workspace/output',
                shell: spec.execution?.shell ?? '/bin/bash',
                ...(spec.execution?.containerName ? { containerName: spec.execution.containerName } : {}),
            },
            dumpWatch: {
                enabled: spec.dumpWatch?.enabled ?? true,
                patterns: spec.dumpWatch?.patterns ?? ["*.dump", "*.lammpstrj", "*.traj", "dump*"],
                parseTimesteps: spec.dumpWatch?.parseTimesteps ?? true,
            },
            cleanup: {
                removeContainer: spec.cleanup?.removeContainer ?? true,
                removeWorkspace: spec.cleanup?.removeWorkspace ?? false,
            },
            outputDir: spec.outputDir,
        };
    }

    private validateInputScript(spec: ResolvedSimulationSpec): void{
        const hasPath = typeof spec.inputScript.path === 'string';
        const hasContent = typeof spec.inputScript.content === 'string';

        if(hasPath === hasContent){
            throw new Error('Simulation inputScript must provide exactly one of "path" or "content".');
        }
    }

    private buildCommand(spec: ResolvedSimulationSpec, mainInputContainerPath: string): string{
        const command: string[] = [];
        
        if(spec.execution.mpiRanks > 1){
            command.push('mpirun', '--allow-run-as-root', '-np', String(spec.execution.mpiRanks));
        }

        command.push(spec.execution.binary, '-in', mainInputContainerPath);

        for(const [key, value] of Object.entries(spec.variables)){
            command.push('-var', key, String(value));
        }
        
        command.push(...spec.execution.extraArgs);

        return command.map((entry) => this.shellEscape(entry)).join(' ');
    }
    
    private shellEscape(value: string): string{
        if(value.length === 0){
            return "''";
        }

        return `'${value.replace(/'/g, `'\\''`)}'`;
    }

    private async handleStdout(run: Run, line: string, interpreter: LammpsOutputInterpreter): Promise<void>{
        this.eventBus.emit('simulation:stdout', {
            runId: run.id,
            line,
            snapshot: run.snapshot()
        });

        for(const event of interpreter.consume(line)){
            if(event.type === 'thermo'){
                if(typeof event.step === 'number'){
                    run.recordStep(event.step);
                    await this.runStore.update(run);
                }
                
                this.eventBus.emit('thermo', {
                    runId: run.id,
                    step: event.step,
                    values: event.values,
                    raw: event.raw,
                    snapshot: run.snapshot()
                });
                
                continue;
            }

            run.recordStep(event.step);
            await this.runStore.update(run);

            this.eventBus.emit('timestep', {
                runId: run.id,
                step: event.step,
                source: event.source,
                snapshot: run.snapshot()
            });
        }
    }

    private async handleDumpFile(
        run: Run,
        filePath: string,
        tracker: DumpFrameTracker,
        parseTimesteps: boolean
    ): Promise<void>{
        this.eventBus.emit('dump:detected', {
            runId: run.id,
            path: filePath,
            snapshot: run.snapshot()
        });

        if(!parseTimesteps){
            return;
        }

        const steps = await tracker.readNewSteps(filePath);

        for(const step of steps){
            run.recordStep(step);
            await this.runStore.update(run);

            this.eventBus.emit('dump:frame', {
                runId: run.id,
                path: filePath,
                step,
                snapshot: run.snapshot()
            });

            this.eventBus.emit('timestep', {
                runId: run.id,
                step,
                source: 'dump',
                snapshot: run.snapshot()
            });
        }
    }

    private async handleError(run: Run, error: Error): Promise<void>{
        this.logger.error(`Run ${run.id} error ${error.message}`);
        this.eventBus.emit('simulation:error', {
            runId: run.id,
            error: error.message,
            snapshot: run.snapshot()
        });
    }

    private async monitorCompletion(
        run: Run,
        container: ContainerHandle,
        spec: ResolvedSimulationSpec,
        workspace: PreparedWorkspace,
        logStream: LogStreamHandle,
        watchHandle: FileWatchHandle | null
    ): Promise<void>{
        try{
            const result = await this.containerManager.wait(container);

            if(run.isStopping()){
                run.markCancelled();
            }else if(result.exitCode === 0){
                run.markCompleted(result.exitCode);
            }else{
                run.markFailed(`Container exited with code ${result.exitCode}.`, result.exitCode);
            }

            await this.runStore.update(run);
            this.emitState(run);

            this.eventBus.emit('simulation:end', {
                runId: run.id,
                exitCode: result.exitCode,
                snapshot: run.snapshot()
            });

        }catch(error){
            const message = error instanceof Error ? error.message : String(error);
            run.markFailed(message, null);
            await this.runStore.update(run);
            this.emitState(run);

            this.eventBus.emit('simulation:error', {
                runId: run.id,
                error: message,
                snapshot: run.snapshot()
            });

            this.eventBus.emit('simulation:end', {
                runId: run.id,
                exitCode: null,
                snapshot: run.snapshot()
            });
        }finally{
            await logStream.close();

            if(watchHandle){
                await watchHandle.close();
            }

            if(spec.cleanup.removeContainer && run.containerId){
                await this.containerManager.remove(this.containerManager.get(run.containerId), true);
            }

            if(spec.cleanup.removeWorkspace){
                await this.workspacePreparer.cleanup(workspace);
            }
        }
    }

    private emitState(run: Run): void{
        this.eventBus.emit('simulation:state', {
            runId: run.id,
            state: run.state,
            snapshot: run.snapshot()
        });
    }
};

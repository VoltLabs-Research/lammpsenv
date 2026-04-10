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
import LammpsCommandBuilder from './LammpsCommandBuilder';
import SimulationEventPublisher from './SimulationEventPublisher';
import SimulationLifecycleManager from './SimulationLifecycleManager';
import StopSimulation from './StopSimulation';

export default class StartSimulation{
    constructor(
        private readonly ensureImage: EnsureImage,
        private readonly workspacePreparer: WorkspacePreparerPort,
        private readonly commandBuilder: LammpsCommandBuilder,
        private readonly containerManager: ContainerManagerPort,
        private readonly logStreamer: LogStreamerPort,
        private readonly fileWatcher: FileWatcher,
        private readonly runStore: RunStore,
        private readonly eventBus: EventBusPort<RuntimeEventMap>,
        private readonly eventPublisher: SimulationEventPublisher,
        private readonly lifecycleManager: SimulationLifecycleManager,
        private readonly stopSimulation: StopSimulation,
        private readonly logger: Logger
    ){}

    async execute(spec: SimulationSpec): Promise<RunHandle>{
        const resolvedSpec = this.resolveSpec(spec);
        
        const imageTag = (typeof resolvedSpec.image === 'string')
            ? resolvedSpec.image
            : (await this.ensureImage.execute(resolvedSpec.image)).tag;
        
        const run = new Run(crypto.randomUUID(), imageTag, resolvedSpec.outputDir);
        await this.lifecycleManager.prepare(run);

        let workspace: PreparedWorkspace | null = null;
        let container: ContainerHandle | null = null;
        let logStream: LogStreamHandle | null = null;
        let watchHandle: FileWatchHandle | null = null;

        try{
            workspace = await this.workspacePreparer.prepare(run.id, resolvedSpec);
            const command = this.commandBuilder.build(resolvedSpec, workspace.mainInputContainerPath);

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

            await this.lifecycleManager.markStarting(run, container.id);

            const outputInterpreter = new LammpsOutputInterpreter();
            const dumpTracker = new DumpFrameTracker();

            logStream = await this.logStreamer.stream(container, {
                onStdout: async (line) => {
                    await this.handleStdout(run, line, outputInterpreter);
                },
                onStderr: async (line) => {
                    this.eventPublisher.stderr(run, line);
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
            await this.lifecycleManager.markRunning(run);

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
            await this.lifecycleManager.fail(run, message);
            await this.cleanupResources(resolvedSpec, workspace, container, logStream, watchHandle);

            throw error;
        }
    }

    private resolveSpec(spec: SimulationSpec): ResolvedSimulationSpec{
        return {
            image: spec.image,
            inputFile: spec.inputFile,
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

    private async handleStdout(run: Run, line: string, interpreter: LammpsOutputInterpreter): Promise<void>{
        this.eventPublisher.stdout(run, line);

        for(const event of interpreter.consume(line)){
            if(event.type === 'thermo'){
                if(typeof event.step === 'number'){
                    await this.recordStep(run, event.step);
                }
                
                this.eventPublisher.thermo(run, event.step, event.values, event.raw);
                
                continue;
            }

            await this.recordStep(run, event.step);
            this.eventPublisher.timestep(run, event.step, event.source);
        }
    }

    private async handleDumpFile(
        run: Run,
        filePath: string,
        tracker: DumpFrameTracker,
        parseTimesteps: boolean
    ): Promise<void>{
        this.eventPublisher.dumpDetected(run, filePath);

        if(!parseTimesteps){
            return;
        }

        const steps = await tracker.readNewSteps(filePath);

        for(const step of steps){
            await this.recordStep(run, step);
            this.eventPublisher.dumpFrame(run, filePath, step);
            this.eventPublisher.timestep(run, step, 'dump');
        }
    }

    private async handleError(run: Run, error: Error): Promise<void>{
        this.logger.error(`Run ${run.id} error ${error.message}`);
        this.eventPublisher.error(run, error.message);
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
            await this.lifecycleManager.settle(run, result.exitCode);
        }catch(error){
            const message = error instanceof Error ? error.message : String(error);
            await this.lifecycleManager.fail(run, message, null);
        }finally{
            await this.cleanupResources(spec, workspace, container, logStream, watchHandle);
        }
    }

    private async recordStep(run: Run, step: number): Promise<void>{
        run.recordStep(step);
        await this.runStore.update(run);
    }

    private async cleanupResources(
        spec: ResolvedSimulationSpec,
        workspace: PreparedWorkspace | null,
        container: ContainerHandle | null,
        logStream: LogStreamHandle | null,
        watchHandle: FileWatchHandle | null
    ): Promise<void>{
        if(logStream){
            await logStream.close();
        }

        if(watchHandle){
            await watchHandle.close();
        }

        if(container && spec.cleanup.removeContainer){
            await this.containerManager.remove(container, true);
        }

        if(workspace && spec.cleanup.removeWorkspace){
            await this.workspacePreparer.cleanup(workspace);
        }
    }
};

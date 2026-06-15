import { RuntimeEventMap } from '@/domain/observability/EventMap';
import Run from '@/domain/simulation/Run';
import { ScalarValue } from '@/domain/shared/types';
import { EventBusPort } from '@/ports/EventBusPort';

export default class SimulationEventPublisher{
    constructor(private readonly eventBus: EventBusPort<RuntimeEventMap>){}

    created(run: Run): void{
        this.eventBus.emit('simulation:created', {
            runId: run.id,
            imageTag: run.imageTag,
            outputDir: run.outputDir,
            snapshot: run.snapshot()
        });
    }

    started(run: Run): void{
        this.eventBus.emit('simulation:start', {
            runId: run.id,
            imageTag: run.imageTag,
            containerId: run.containerId!,
            outputDir: run.outputDir,
            snapshot: run.snapshot()
        });
    }

    state(run: Run): void{
        this.eventBus.emit('simulation:state', {
            runId: run.id,
            state: run.state,
            snapshot: run.snapshot()
        });
    }

    stdout(run: Run, line: string): void{
        this.eventBus.emit('simulation:stdout', {
            runId: run.id,
            line,
            snapshot: run.snapshot()
        });
    }

    stderr(run: Run, line: string): void{
        this.eventBus.emit('simulation:stderr', {
            runId: run.id,
            line,
            snapshot: run.snapshot()
        });
    }

    error(run: Run, error: string): void{
        this.eventBus.emit('simulation:error', {
            runId: run.id,
            error,
            snapshot: run.snapshot()
        });
    }

    end(run: Run, exitCode: number | null): void{
        this.eventBus.emit('simulation:end', {
            runId: run.id,
            exitCode,
            snapshot: run.snapshot()
        });
    }

    thermo(
        run: Run,
        step: number | null,
        values: Record<string, ScalarValue>,
        raw: string
    ): void{
        this.eventBus.emit('thermo', {
            runId: run.id,
            step,
            values,
            raw,
            snapshot: run.snapshot()
        });
    }

    timestep(run: Run, step: number, source: 'thermo' | 'dump'): void{
        this.eventBus.emit('timestep', {
            runId: run.id,
            step,
            source,
            snapshot: run.snapshot()
        });
    }

    dumpDetected(run: Run, path: string): void{
        this.eventBus.emit('dump:detected', {
            runId: run.id,
            path,
            snapshot: run.snapshot()
        });
    }

    dumpFrame(run: Run, path: string, step: number): void{
        this.eventBus.emit('dump:frame', {
            runId: run.id,
            path,
            step,
            snapshot: run.snapshot()
        });
    }
};

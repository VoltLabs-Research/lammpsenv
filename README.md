# lammps-runtime
`lammps-runtime` provides a modular TypeScript API for building custom LAMMPS Docker images, executing simulations in containers, and exposing real-time runtime observability, thermodynamic output, dumps, and lifecycle events.

## Quick Start
```typescript
import { LammpsRuntime } from '@voltstack/lammps-runtime';

const runtime = new LammpsRuntime();

runtime.on('build:log', ({ message }) => {
    console.log(`[build] ${message}`);
});

runtime.on('simulation:error', ({ runId, error }) => {
    console.error(`[${runId}] ${error}`);
});

const image = await runtime.build({
    version: 'stable',
    packages: ['MOLECULE', 'KSPACE', 'MANYBODY'],
    mpi: true,
    openmp: true
});

const run = await runtime.run({
    image: image.tag,
    inputFile: './examples/in.lmp',
    outputDir: './runs/run-001',
    execution: { mpiRanks: 4 },
    dumpWatch: {
        enabled: true,
        parseTimesteps: true
    }
});

run.on('simulation:stdout', ({ line }) => {
    console.log(line);
});

run.on('thermo', ({ step, values }) => {
    console.log(step, values);
});

run.on('dump:frame', ({ path, step }) => {
    console.log(path, step);
});

const result = await run.waitForEnd();

console.log(result);
```

## Main API
### LammpsRuntime
- build(spec) builds or reuses a Docker image for LAMMPS
- run(spec) starts a simulation and returns a RunHandle
- stop(runId) requests a graceful stop
- kill(runId) force-kills the run container
- getRun(runId) returns the latests run snapshopt
- listRuns() returns all in-memory run snapshopts
- on(), off(), once() subscribe to runtime events

### RunHandle
- on(event, handler) subscribe only to events for that run
- snapshopt() get current run state
- stop() stop the simulation
- kill() kill the simulation
- waitForEnd(timeoutMs?) wait until the run finishes

### Events
- build:start
- build:log
- build:end
- build:error
- simulation:created
- simulation:start
- simulation:stdout
- simulation:stderr
- simulation:state
- simulation:end
- simulation:error
- thermo
- timestep
- dump:detected
- dump:frame

## LICENSE

MIT 

import { LammpsRuntime } from '../src';

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
    inputScript: {
        path: './in.lmp'
    },
    outputDir: './runs/run-001',
    variables: {
        temperature: 300,
        steps: 10000
    },
    resources: {
        cpus: 4,
        memory: '8g'
    },
    execution: {
        mpiRanks: 4
    },
    dumpWatch: {
        // TODO: always enabled
        enabled: true,
        parseTimesteps: true
    }
});

run.on('simulation:stdout', ({ line }) => {
    console.log(line);
});

run.on('thermo', ({ step, values }) => {
    console.log('thermo', step, values);
});

run.on('timestep', ({ step, source }) => {
    console.log('timestep', step, source);
});

run.on('dump:frame', ({ path, step }) => {
    console.log('dump frame', path, step);
});

const result = await run.waitForEnd();

console.log(result);
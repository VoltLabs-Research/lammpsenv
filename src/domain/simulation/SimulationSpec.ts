import { BuildSpec } from '@/domain/build/BuildSpec';

export interface SimulationResources{
    cpus?: number;
    memory?: string;
    gpus?: 'all' | number;
};

export interface SimulationExecution{
    binary?: string;
    mpiRanks?: number;
    extraArgs?: string[];
    containerName?: string;
    workingDir?: string;
    shell?: string;
};

export interface DumpWatchSpec{
    enabled?: boolean;
    patterns?: string[];
    parseTimesteps?: boolean;
};

export interface CleanupPolicy{
    removeContainer?: boolean;
    removeWorkspace?: boolean;
};

export interface SimulationSpec{
    image: string | BuildSpec;
    inputFile: string;
    inputFiles?: string[];
    variables?: Record<string, string | number | boolean>;
    env?: Record<string, string>;
    labels?: Record<string, string>;
    resources?: SimulationResources;
    execution?: SimulationExecution;
    dumpWatch?: DumpWatchSpec;
    cleanup?: CleanupPolicy;
    outputDir: string;
};

export interface ResolvedSimulationSpec{
    image: string | BuildSpec;
    inputFile: string;
    inputFiles: string[];
    variables: Record<string, string | number | boolean>;
    env: Record<string, string>;
    labels: Record<string, string>;
    resources: SimulationResources;
    execution: Required<Pick<SimulationExecution, "binary" | "mpiRanks" | "extraArgs" | "workingDir" | "shell">> & Pick<SimulationExecution, "containerName">;
    dumpWatch: Required<Pick<DumpWatchSpec, "enabled" | "patterns" | "parseTimesteps">>;
    cleanup: Required<CleanupPolicy>;
    outputDir: string;
};

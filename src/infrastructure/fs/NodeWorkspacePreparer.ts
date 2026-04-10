import { access, copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { SimulationSpec } from '@/domain/simulation/SimulationSpec';
import type { Logger } from '@/ports/Logger';
import type { PreparedWorkspace, WorkspacePreparerPort } from '@/ports/WorkspacePreparerPort';

export default class NodeWorkspacePreparer implements WorkspacePreparerPort{
    constructor(private readonly logger: Logger){}

    async prepare(runId: string, spec: SimulationSpec): Promise<PreparedWorkspace>{
        const outputDir = path.resolve(spec.outputDir);
        const workspaceDir = path.join(outputDir, '.lammps-runtime', runId);
        const inputDir = path.join(workspaceDir, 'input');

        await mkdir(outputDir, { recursive: true });
        await mkdir(inputDir, { recursive: true });

        return await this.prepareFromPath(spec, outputDir, workspaceDir, inputDir);
    }

    async cleanup(workspace: PreparedWorkspace): Promise<void>{
        await rm(workspace.workspaceDir, { recursive: true, force: true });
    }

    private async prepareFromPath(
        spec: SimulationSpec,
        outputDir: string,
        workspaceDir: string,
        inputDir: string
    ): Promise<PreparedWorkspace>{
        const mainScriptPath = path.resolve(spec.inputFile);
        const inputFiles = (spec.inputFiles ?? []).map((value) => path.resolve(value));

        await this.ensurePathExists(mainScriptPath, 'Simulation input script');

        for(const inputFilePath of inputFiles){
            await this.ensurePathExists(inputFilePath, 'Simulation input file');
        }

        const sourceRoot = this.findCommonRoot([ mainScriptPath, ...inputFiles ]);

        let mainInputHostPath = '';

        for(const sourcePath of [mainScriptPath, ...inputFiles]){
            const relativePath = this.resolveRelativeTarget(sourceRoot, sourcePath);
            const targetPath = path.join(inputDir, relativePath);

            await mkdir(path.dirname(targetPath), { recursive: true });
            await copyFile(sourcePath, targetPath);

            if(sourcePath === mainScriptPath){
                mainInputHostPath = targetPath;
            }
        }

        if(mainInputHostPath.length === 0){
            throw new Error('Main input script could not be staged.');
        }

        this.logger.info('Prepared simulation workspace from script path.', {
            outputDir,
            workspaceDir,
            inputDir
        });

        return {
            outputDir,
            workspaceDir,
            inputDir,
            mainInputHostPath,
            mainInputContainerPath: this.toPosixPath(
                path.join("/workspace/input", path.relative(inputDir, mainInputHostPath)),
            ),
        };
    }

    private findCommonRoot(paths: string[]): string{
        if(paths.length === 0) return process.cwd();

        const [first, ...rest] = paths;
        const firstParts = first.split(path.sep).filter(Boolean);
        let commonParts= [...firstParts];

        for(const currentPath of rest){
            const currentParts = currentPath.split(path.sep).filter(Boolean);
            let index = 0;

            while(index < commonParts.length && index < currentParts.length && commonParts[index] === currentParts[index]){
                index += 1;
            }

            commonParts = commonParts.slice(0, index);
        }

        return path.join(path.parse(first).root, ...commonParts);
    }

    private resolveRelativeTarget(rootPath: string, filePath: string): string{
        const relativePath = path.relative(rootPath, filePath);

        if(
            relativePath.length > 0 &&
            !relativePath.startsWith('..') && 
            !path.isAbsolute(relativePath) &&
            relativePath !== '.'
        ){
            return relativePath;
        }

        return path.basename(filePath);
    }

    private toPosixPath(value: string): string{
        return value.split(path.sep).join(path.posix.sep);
    }

    private async ensurePathExists(targetPath: string, label: string): Promise<void>{
        try{
            await access(targetPath);
        }catch{
            throw new Error(
                `${label} was not found: "${targetPath}". ` +
                `Current working directory: "${process.cwd()}".`
            );
        }
    }
};

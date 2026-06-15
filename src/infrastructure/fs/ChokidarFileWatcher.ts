import path from 'node:path';
import { watch } from 'chokidar';
import type { Logger } from '@/ports/Logger';
import type { FileWatchHandle, FileWatchHandlers, FileWatcher } from '@/ports/FileWatcher';

type ChokidarWatcher = ReturnType<typeof watch>;

export default class ChokidarFileWatcher implements FileWatcher{
    constructor(private readonly logger: Logger){}

    async watch(
        rootPath: string,
        patterns: string[],
        handlers: FileWatchHandlers
    ): Promise<FileWatchHandle>{
        const watcher = watch(rootPath, {
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 200,
                pollInterval: 50
            }
        });

        this.bindFileEvent(watcher, 'add', patterns, handlers, handlers.onAdd);
        this.bindFileEvent(watcher, 'change', patterns, handlers, handlers.onChange);

        watcher.on('error', (error) => {
            this.logger.error('File watcher error.', { error: String(error) });
            Promise.resolve(handlers.onError(error instanceof Error ? error : new Error(String(error))));
        });

        return {
            close: async () => await watcher.close()
        };
    }

    private bindFileEvent(
        watcher: ChokidarWatcher,
        eventName: 'add' | 'change',
        patterns: string[],
        handlers: FileWatchHandlers,
        handle: (filePath: string) => void | Promise<void>
    ): void{
        watcher.on(eventName, (filePath) => {
            if(!this.matches(filePath, patterns)) return;

            Promise.resolve(handle(filePath)).catch((error) => {
                Promise.resolve(handlers.onError(error instanceof Error ? error : new Error(String(error))));
            });
        });
    }

    private matches(filePath: string, patterns: string[]): boolean{
        if(patterns.length === 0){
            return true;
        }

        const fileName = path.basename(filePath);
        return patterns.some((pattern) => this.compilePattern(pattern).test(fileName));
    }

    private compilePattern(pattern: string): RegExp{
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
        return new RegExp(`^${escaped}$`, 'i');
    }
};

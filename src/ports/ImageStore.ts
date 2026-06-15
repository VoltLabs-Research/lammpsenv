import type { BuildSpec } from '@/domain/build/BuildSpec';

export interface ImageRecord{
    tag: string;
    hash: string;
    spec: BuildSpec;
    createdAt: string;
    imageId?: string;
};

export interface ImageStore{
    save(record: ImageRecord): Promise<void>;
};

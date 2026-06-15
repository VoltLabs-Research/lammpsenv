import { ImageRecord, ImageStore } from '@/ports/ImageStore';

export default class InMemoryImageStore implements ImageStore{
    private readonly images = new Map<string, ImageRecord>();

    async save(record: ImageRecord): Promise<void>{
        this.images.set(record.tag, record);
    }
};

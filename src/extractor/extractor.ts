import { IVideo, ISource, ISubtitle } from './types';

abstract class VideoExtractor {
    /**
     * The server name of the video provider
     */
    protected abstract serverName: string;

    /**
     * list of videos available
     */
    protected abstract sources: IVideo[];

    /**
     * takes video link
     *
     * returns video sources (video links) available
     */
    protected abstract extract(videoUrl: URL, ...args: any): Promise<IVideo> | Promise<{ source: IVideo } & { subtitles: ISubtitle[] }>;
}

export default VideoExtractor;
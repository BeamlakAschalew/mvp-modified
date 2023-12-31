import * as FormData_2 from 'form-data';

declare type Caption = {
    type: CaptionType;
    url: string;
    hasCorsRestrictions: boolean;
    language: string;
};

declare type CaptionType = keyof typeof captionTypes;

declare const captionTypes: {
    srt: string;
    vtt: string;
};

declare type CommonMedia = {
    title: string;
    releaseYear: number;
    imdbId?: string;
    tmdbId: string;
};

declare type DefaultedFetcherOptions = {
    baseUrl?: string;
    body?: Record<string, any> | string | FormData_2;
    headers: Record<string, string>;
    query: Record<string, string>;
    method: 'GET' | 'POST';
};

declare type DiscoverEmbedsEvent = {
    sourceId: string;
    embeds: Array<{
        id: string;
        embedScraperId: string;
    }>;
};

export declare type EmbedOutput = {
    stream: Stream;
};

export declare interface EmbedRunnerOptions {
    events?: IndividualScraperEvents;
    url: string;
    id: string;
}

declare type Fetcher<T = any> = {
    (url: string, ops: DefaultedFetcherOptions): Promise<T>;
};

declare type FetchHeaders = {
    get(key: string): string | null;
};

declare type FetchLike = (url: string, ops?: FetchOps | undefined) => Promise<FetchReply>;

/**
 * This file is a very relaxed definition of the fetch api
 * Only containing what we need for it to function.
 */
declare type FetchOps = {
    headers: Record<string, string>;
    method: string;
    body: any;
};

declare type FetchReply = {
    text(): Promise<string>;
    json(): Promise<any>;
    headers: FetchHeaders;
};

declare type FileBasedStream = {
    type: 'file';
    flags: Flags[];
    qualities: Partial<Record<Qualities, StreamFile>>;
    captions: Caption[];
};

export declare type Flags = (typeof flags)[keyof typeof flags];

export declare const flags: {
    readonly NO_CORS: "no-cors";
};

export declare type FullScraperEvents = {
    update?: (evt: UpdateEvent) => void;
    init?: (evt: InitEvent) => void;
    discoverEmbeds?: (evt: DiscoverEmbedsEvent) => void;
    start?: (id: string) => void;
};

declare type HlsBasedStream = {
    type: 'hls';
    flags: Flags[];
    playlist: string;
    captions: Caption[];
};

declare type IndividualScraperEvents = {
    update?: (evt: UpdateEvent) => void;
};

declare type InitEvent = {
    sourceIds: string[];
};

export declare function makeProviders(ops: ProviderBuilderOptions): ProviderControls;

export declare function makeSimpleProxyFetcher(proxyUrl: string, f: FetchLike): Fetcher;

export declare function makeStandardFetcher(f: FetchLike): Fetcher;

export declare type MediaTypes = 'show' | 'movie';

export declare type MetaOutput = {
    type: 'embed' | 'source';
    id: string;
    rank: number;
    name: string;
    mediaTypes?: Array<MediaTypes>;
};

export declare type MovieMedia = CommonMedia & {
    type: 'movie';
};

export declare class NotFoundError extends Error {
    constructor(reason?: string);
}

export declare interface ProviderBuilderOptions {
    fetcher: Fetcher;
    proxiedFetcher?: Fetcher;
    target: Targets;
}

export declare interface ProviderControls {
    runAll(runnerOps: RunnerOptions): Promise<RunOutput | null>;
    runSourceScraper(runnerOps: SourceRunnerOptions): Promise<SourcererOutput>;
    runEmbedScraper(runnerOps: EmbedRunnerOptions): Promise<EmbedOutput>;
    getMetadata(id: string): MetaOutput | null;
    listSources(): MetaOutput[];
    listEmbeds(): MetaOutput[];
}

declare type Qualities = 'unknown' | '360' | '480' | '720' | '1080';

export declare interface RunnerOptions {
    sourceOrder?: string[];
    embedOrder?: string[];
    events?: FullScraperEvents;
    media: ScrapeMedia;
}

export declare type RunOutput = {
    sourceId: string;
    embedId?: string;
    stream: Stream;
};

export declare type ScrapeMedia = ShowMedia | MovieMedia;

export declare type ShowMedia = CommonMedia & {
    type: 'show';
    episode: {
        number: number;
        tmdbId: string;
    };
    season: {
        number: number;
        tmdbId: string;
    };
};

export declare type SourcererOutput = {
    embeds: {
        embedId: string;
        url: string;
    }[];
    stream?: Stream;
};

export declare interface SourceRunnerOptions {
    events?: IndividualScraperEvents;
    media: ScrapeMedia;
    id: string;
}

declare type Stream = FileBasedStream | HlsBasedStream;

declare type StreamFile = {
    type: 'mp4';
    url: string;
    headers?: Record<string, string>;
};

export declare type Targets = (typeof targets)[keyof typeof targets];

export declare const targets: {
    readonly BROWSER: "browser";
    readonly NATIVE: "native";
    readonly ALL: "all";
};

declare type UpdateEvent = {
    id: string;
    percentage: number;
    status: UpdateEventStatus;
    error?: unknown;
    reason?: string;
};

declare type UpdateEventStatus = 'success' | 'failure' | 'notfound' | 'pending';

export { }

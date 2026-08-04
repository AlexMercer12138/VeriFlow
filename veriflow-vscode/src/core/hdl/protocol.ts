import type { HdlDocument } from './model';
import type { ParsePriority } from './parserQueue';
import type { PreprocessOptions } from './preprocessor';

export type { ParsePriority } from './parserQueue';

export type HdlParseOptions = PreprocessOptions & {
    cacheMode?: 'document' | 'ephemeral';
};

export type ParseRequest = {
    type: 'parse';
    requestId: string;
    uri: string;
    version: number;
    text: string;
    priority: ParsePriority;
    options: HdlParseOptions;
};

export type CancelRequest = {
    type: 'cancel';
    requestId: string;
};

export type DisposeRequest = {
    type: 'dispose';
};

export type ParserWorkerRequest = ParseRequest | CancelRequest | DisposeRequest;

export type ParsedResponse = {
    type: 'parsed';
    requestId: string;
    document: HdlDocument;
};

export type FailedResponse = {
    type: 'failed';
    requestId: string;
    message: string;
};

export type ParserWorkerResponse = ParsedResponse | FailedResponse;

import type { HdlDocument } from './model';

export type ParseRequest = {
    type: 'parse';
    requestId: string;
    uri: string;
    version: number;
    text: string;
    priority: 'interactive' | 'background';
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

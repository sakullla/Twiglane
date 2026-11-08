/// <reference lib="webworker" />
import { parseMarkdownDocument } from "./parser";

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (event: MessageEvent<string>) => {
  scope.postMessage(parseMarkdownDocument(event.data));
};

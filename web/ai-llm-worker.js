/* PaperDesk text AI: runs a small language model with WebLLM (WebGPU) in a
   background thread. The page talks to it through WebWorkerMLCEngine. */
import { WebWorkerMLCEngineHandler } from 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.86/+esm';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);

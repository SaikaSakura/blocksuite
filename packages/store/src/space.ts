import type * as Y from 'yjs';
import type { SelectionRange } from './awareness.js';
import type { RichTextAdapter } from './text-adapter.js';
import type { DataInitializer } from './yjs/proxy.js';
import type { BlockSuiteDoc } from './yjs/index.js';
import type { AwarenessAdapter } from './awareness.js';

export interface StackItem {
  meta: Map<'cursor-location', SelectionRange | undefined>;
  type: 'undo' | 'redo';
}

export class Space<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Data extends Record<string, unknown> = Record<string, any>,
  Flags extends Record<string, unknown> = BlockSuiteFlags
> {
  /** unprefixed id */
  readonly id: string;
  readonly doc: BlockSuiteDoc;
  readonly awarenessAdapter: AwarenessAdapter;
  /**
   * @internal
   * @protected
   */
  protected readonly proxy: Data;
  protected readonly origin: Y.Map<Data[keyof Data]>;
  readonly richTextAdapters = new Map<string, RichTextAdapter>();

  constructor(
    id: string,
    doc: BlockSuiteDoc,
    awarenessAdapter: AwarenessAdapter,
    options?: {
      valueInitializer?: DataInitializer<Partial<Data>>;
    }
  ) {
    this.id = id;
    this.doc = doc;
    this.awarenessAdapter = awarenessAdapter;
    const targetId = this.id.startsWith('space:') ? this.id : this.prefixedId;
    this.origin = this.doc.getMap(targetId);
    this.proxy = this.doc.getMapProxy<string, Data>(targetId, {
      initializer: options?.valueInitializer,
    });
  }

  get prefixedId() {
    return `space:${this.id}`;
  }

  transact(fn: () => void) {
    this.doc.transact(fn, this.doc.clientID);
  }
}

import * as Y from 'yjs';
import type { Quill } from 'quill';
import { uuidv4 } from 'lib0/random.js';
import { BaseBlockModel } from '../base.js';
import { Space, StackItem } from '../space.js';
import {
  Text,
  PrelimText,
  RichTextAdapter,
  TextType,
} from '../text-adapter.js';
import type { IdGenerator } from '../utils/id-generator.js';
import { Signal } from '@blocksuite/global/utils';
import {
  assertValidChildren,
  initInternalProps,
  syncBlockProps,
  trySyncTextProp,
  toBlockProps,
} from '../utils/utils.js';
import type { PageMeta, Workspace } from './workspace.js';
import type { BlockSuiteDoc } from '../yjs/index.js';
import { tryMigrate } from './migrations.js';
import { assertExists, matchFlavours } from '@blocksuite/global/utils';
import { debug } from '@blocksuite/global/debug';
import BlockTag = BlockSuiteInternal.BlockTag;
import TagSchema = BlockSuiteInternal.TagSchema;
import type { AwarenessAdapter } from '../awareness.js';
export type YBlock = Y.Map<unknown>;
export type YBlocks = Y.Map<YBlock>;

/** JSON-serializable properties of a block */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BlockProps = Record<string, any> & {
  id: string;
  flavour: string;
  text?: void | TextType;
  children?: BaseBlockModel[];
};

export type PrefixedBlockProps = Record<string, unknown> & {
  'sys:id': string;
  'sys:flavour': string;
};

const isWeb = typeof window !== 'undefined';

function createChildMap(yChildIds: Y.Array<string>) {
  return new Map(yChildIds.map((child, index) => [child, index]));
}

export type PageData = {
  [key: string]: YBlock;
};

export class Page extends Space<PageData> {
  private _workspace: Workspace;
  private _idGenerator: IdGenerator;
  private _history!: Y.UndoManager;
  private _root: BaseBlockModel | BaseBlockModel[] | null = null;
  private _blockMap = new Map<string, BaseBlockModel>();
  private _splitSet = new Set<Text | PrelimText>();
  private _synced = false;

  // TODO use schema
  private _ignoredKeys = new Set<string>(
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    Object.keys(new BaseBlockModel(this, { id: null! }))
  );

  readonly signals = {
    historyUpdated: new Signal(),
    rootAdded: new Signal<BaseBlockModel | BaseBlockModel[]>(),
    rootDeleted: new Signal<string | string[]>(),
    textUpdated: new Signal<Y.YTextEvent>(),
    updated: new Signal(),
  };

  constructor(
    workspace: Workspace,
    id: string,
    doc: BlockSuiteDoc,
    awarenessAdapter: AwarenessAdapter,
    idGenerator: IdGenerator = uuidv4
  ) {
    super(id, doc, awarenessAdapter);
    this._workspace = workspace;
    this._idGenerator = idGenerator;
  }

  get workspace() {
    return this._workspace;
  }

  get meta() {
    return this.workspace.meta.getPageMeta(this.id) as PageMeta;
  }

  get tags() {
    assertExists(this.root);
    assertExists(this.root.flavour === 'affine:page');
    return this.root.tags as Y.Map<Y.Map<unknown>>;
  }

  get tagSchema() {
    assertExists(this.root);
    assertExists(this.root.flavour === 'affine:page');
    return this.root.tagSchema as Y.Map<unknown>;
  }

  get blobs() {
    return this.workspace.blobs;
  }

  /** key-value store of blocks */
  private get _yBlocks(): YBlocks {
    return this.origin;
  }

  get root() {
    return Array.isArray(this._root) ? this._root[0] : this._root;
  }

  get rootLayer() {
    return Array.isArray(this._root) ? this._root[1] : null;
  }

  /** @internal used for getting surface block elements for phasor */
  get ySurfaceContainer() {
    assertExists(this.rootLayer);
    const ySurface = this._yBlocks.get(this.rootLayer.id);
    if (ySurface?.has('elements')) {
      return ySurface.get('elements') as Y.Map<unknown>;
    } else {
      ySurface?.set('elements', new Y.Map());
      return ySurface?.get('elements') as Y.Map<unknown>;
    }
  }

  get isEmpty() {
    return this._yBlocks.size === 0;
  }

  get canUndo() {
    if (this.awarenessAdapter.isReadonly(this)) {
      return false;
    }
    return this._history.canUndo();
  }

  get canRedo() {
    if (this.awarenessAdapter.isReadonly(this)) {
      return false;
    }
    return this._history.canRedo();
  }

  get Text() {
    return Text;
  }

  undo = () => {
    if (this.awarenessAdapter.isReadonly(this)) {
      console.error('cannot modify data in readonly mode');
      return;
    }
    this._history.undo();
  };

  redo = () => {
    if (this.awarenessAdapter.isReadonly(this)) {
      console.error('cannot modify data in readonly mode');
      return;
    }
    this._history.redo();
  };

  /** Capture current operations to undo stack synchronously. */
  captureSync = () => {
    this._history.stopCapturing();
  };

  resetHistory = () => {
    this._history.clear();
  };

  updateBlockTag<Tag extends BlockTag>(id: BaseBlockModel['id'], tag: Tag) {
    const already = this.tags.has(id);
    let tags: Y.Map<unknown>;
    if (!already) {
      tags = new Y.Map();
    } else {
      tags = this.tags.get(id) as Y.Map<unknown>;
    }
    this.transact(() => {
      if (!already) {
        this.tags.set(id, tags);
      }
      tags.set(tag.type, tag);
    });
  }

  getBlockTags(model: BaseBlockModel): Record<string, BlockTag> {
    const tags = this.tags.get(model.id);
    if (!tags) {
      return {};
    }
    // fixme: performance issue
    return tags.toJSON();
  }

  getBlockTagByTagSchema(
    model: BaseBlockModel,
    schema: TagSchema
  ): BlockTag | null {
    const tags = this.tags.get(model.id);
    return (tags?.get(schema.id) as BlockTag) ?? null;
  }

  getTagSchema(id: TagSchema['id']) {
    return this.tagSchema.get(id) ?? (null as TagSchema | null);
  }

  setTagSchema(schema: TagSchema) {
    return this.tagSchema.set(schema.id, schema);
  }

  getBlockById(id: string) {
    return this._blockMap.get(id) ?? null;
  }

  getBlockByFlavour(blockFlavour: string) {
    return [...this._blockMap.values()].filter(
      ({ flavour }) => flavour === blockFlavour
    );
  }

  getParentById(rootId: string, target: BaseBlockModel): BaseBlockModel | null {
    if (rootId === target.id) return null;

    const root = this._blockMap.get(rootId);
    if (!root) return null;

    for (const [childId] of root.childMap) {
      if (childId === target.id) return root;

      const parent = this.getParentById(childId, target);
      if (parent !== null) return parent;
    }
    return null;
  }

  getParent(block: BaseBlockModel) {
    if (!this.root) return null;

    return this.getParentById(this.root.id, block);
  }

  getPreviousSibling(block: BaseBlockModel) {
    const parent = this.getParent(block);
    if (!parent) {
      return null;
    }
    const index = parent.children.indexOf(block);
    if (index === -1) {
      throw new Error(
        "Failed to getPreviousSiblings! Block not found in parent's children"
      );
    }
    return parent.children[index - 1] ?? null;
  }

  getPreviousSiblings(block: BaseBlockModel) {
    const parent = this.getParent(block);
    if (!parent) {
      return [];
    }
    const index = parent.children.indexOf(block);
    if (index === -1) {
      throw new Error(
        "Failed to getPreviousSiblings! Block not found in parent's children"
      );
    }
    return parent.children.slice(0, index);
  }

  getNextSibling(block: BaseBlockModel) {
    const parent = this.getParent(block);
    if (!parent) {
      return null;
    }
    const index = parent.children.indexOf(block);
    if (index === -1) {
      throw new Error(
        "Failed to getPreviousSiblings! Block not found in parent's children"
      );
    }
    return parent.children[index + 1] ?? null;
  }

  getNextSiblings(block: BaseBlockModel) {
    const parent = this.getParent(block);
    if (!parent) {
      return [];
    }
    const index = parent.children.indexOf(block);
    if (index === -1) {
      throw new Error(
        "Failed to getNextSiblings! Block not found in parent's children"
      );
    }
    return parent.children.slice(index + 1);
  }

  @debug('CRUD')
  public addBlockByFlavour<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ALLProps extends Record<string, any> = BlockSuiteModelProps.ALL,
    Flavour extends keyof ALLProps & string = keyof ALLProps & string
  >(
    flavour: Flavour,
    blockProps: Partial<
      ALLProps[Flavour] &
        Omit<BlockSuiteInternal.IBaseBlockProps, 'flavour' | 'id'>
    > = {},
    parent?: BaseBlockModel | string | null,
    parentIndex?: number
  ) {
    if (this.awarenessAdapter.isReadonly(this)) {
      throw new Error('cannot modify data in readonly mode');
    }
    if (!flavour) {
      throw new Error('Block props must contain flavour');
    }

    // if (blockProps.flavour === 'affine:shape') {
    //   if (parent != null || parentIndex != null) {
    //     throw new Error('Shape block should only be appear under page');
    //   }
    // }

    const clonedProps: Partial<BlockProps> = { flavour, ...blockProps };
    const id = this._idGenerator();
    clonedProps.id = id;

    this.transact(() => {
      const yBlock = new Y.Map() as YBlock;

      assertValidChildren(this._yBlocks, clonedProps);
      initInternalProps(yBlock, clonedProps);
      syncBlockProps(yBlock, clonedProps, this._ignoredKeys);
      trySyncTextProp(this._splitSet, yBlock, clonedProps.text);

      if (typeof parent === 'string') {
        parent = this._blockMap.get(parent);
      }

      const parentId = parent === null ? null : parent?.id ?? this.root?.id;

      if (parentId) {
        const yParent = this._yBlocks.get(parentId) as YBlock;
        const yChildren = yParent.get('sys:children') as Y.Array<string>;
        const index = parentIndex ?? yChildren.length;
        yChildren.insert(index, [id]);
      }

      this._yBlocks.set(id, yBlock);
    });
    return id;
  }

  /**
   * @deprecated use `addBlockByFlavour`
   */
  addBlock<T extends BlockProps>(
    blockProps: Partial<T>,
    parent?: BaseBlockModel | string | null,
    parentIndex?: number
  ): string {
    return this.addBlockByFlavour(
      blockProps.flavour as Parameters<typeof this.addBlockByFlavour>[0],
      blockProps as Parameters<typeof this.addBlockByFlavour>[1],
      parent,
      parentIndex
    );
  }

  updateBlockById(id: string, props: Partial<BlockProps>) {
    if (this.awarenessAdapter.isReadonly(this)) {
      console.error('cannot modify data in readonly mode');
      return;
    }
    const model = this._blockMap.get(id) as BaseBlockModel;
    this.updateBlock(model, props);
  }

  @debug('CRUD')
  moveBlock(model: BaseBlockModel, targetModel: BaseBlockModel, top = true) {
    if (this.awarenessAdapter.isReadonly(this)) {
      console.error('cannot modify data in readonly mode');
      return;
    }
    const currentParentModel = this.getParent(model);
    const nextParentModel = this.getParent(targetModel);
    if (currentParentModel === null || nextParentModel === null) {
      throw new Error('cannot find parent model');
    }
    this.transact(() => {
      const yParentA = this._yBlocks.get(currentParentModel.id) as YBlock;
      const yChildrenA = yParentA.get('sys:children') as Y.Array<string>;
      const idx = yChildrenA.toArray().findIndex(id => id === model.id);
      yChildrenA.delete(idx);
      const yParentB = this._yBlocks.get(nextParentModel.id) as YBlock;
      const yChildrenB = yParentB.get('sys:children') as Y.Array<string>;
      const nextIdx = yChildrenB
        .toArray()
        .findIndex(id => id === targetModel.id);
      if (top) {
        yChildrenB.insert(nextIdx, [model.id]);
      } else {
        yChildrenB.insert(nextIdx + 1, [model.id]);
      }
    });
    currentParentModel.propsUpdated.emit();
    nextParentModel.propsUpdated.emit();
  }

  @debug('CRUD')
  updateBlock<T extends Partial<BlockProps>>(model: BaseBlockModel, props: T) {
    if (this.awarenessAdapter.isReadonly(this)) {
      console.error('cannot modify data in readonly mode');
      return;
    }
    const yBlock = this._yBlocks.get(model.id) as YBlock;

    this.transact(() => {
      if (props.text instanceof PrelimText) {
        props.text.ready = true;
      } else if (props.text instanceof Text) {
        model.text = props.text;
        // @ts-ignore
        yBlock.set('prop:text', props.text._yText);
      }

      // TODO diff children changes
      // All child nodes will be deleted in the current behavior, then added again.
      // Through diff children changes, the experience can be improved.
      if (props.children) {
        const yChildren = new Y.Array<string>();
        yChildren.insert(
          0,
          props.children.map(child => child.id)
        );
        yBlock.set('sys:children', yChildren);
      }

      syncBlockProps(yBlock, props, this._ignoredKeys);
    });
  }

  @debug('CRUD')
  insertBlock(
    blockProps: Partial<BaseBlockModel>,
    targetModel: BaseBlockModel,
    top = true
  ) {
    const targetParentModel = this.getParent(targetModel);
    if (targetParentModel === null) {
      throw new Error('cannot find parent model');
    }
    this.transact(() => {
      const yParent = this._yBlocks.get(targetParentModel.id) as YBlock;
      const yChildren = yParent.get('sys:children') as Y.Array<string>;
      const targetIdx = yChildren
        .toArray()
        .findIndex(id => id === targetModel.id);
      assertExists(blockProps.flavour);
      this.addBlockByFlavour(
        blockProps.flavour,
        {
          type: blockProps.type,
        },
        targetParentModel.id,
        top ? targetIdx : targetIdx + 1
      );
      // }
    });
  }

  deleteBlockById(id: string) {
    if (this.awarenessAdapter.isReadonly(this)) {
      console.error('cannot modify data in readonly mode');
      return;
    }
    const model = this._blockMap.get(id) as BaseBlockModel;
    this.deleteBlock(model);
  }

  @debug('CRUD')
  deleteBlock(
    model: BaseBlockModel,
    options: {
      bringChildrenTo: 'parent' | BaseBlockModel;
    } = {
      bringChildrenTo: 'parent',
    }
  ) {
    if (this.awarenessAdapter.isReadonly(this)) {
      console.error('cannot modify data in readonly mode');
      return;
    }
    const parent = this.getParent(model);
    const index = parent?.children.indexOf(model) ?? -1;
    if (index > -1) {
      parent?.children.splice(parent.children.indexOf(model), 1);
    }
    if (options.bringChildrenTo === 'parent' && parent) {
      parent.children.unshift(...model.children);
    } else if (options.bringChildrenTo instanceof BaseBlockModel) {
      options.bringChildrenTo.children.unshift(...model.children);
    }
    this._blockMap.delete(model.id);

    this.transact(() => {
      this._yBlocks.delete(model.id);
      const children = model.children.map(model => model.id);
      model.dispose();

      if (parent) {
        const yParent = this._yBlocks.get(parent.id) as YBlock;
        const yChildren = yParent.get('sys:children') as Y.Array<string>;

        if (index > -1) {
          yChildren.delete(index, 1);
        }
        if (options.bringChildrenTo === 'parent' && parent) {
          yChildren.unshift(children);
        } else if (options.bringChildrenTo instanceof BaseBlockModel) {
          this.updateBlockById(options.bringChildrenTo.id, {
            children: options.bringChildrenTo.children,
          });
        }
      }
    });
  }

  /** Connect a rich text editor instance with a YText instance. */
  attachRichText = (id: string, quill: Quill) => {
    const yBlock = this._getYBlock(id);

    const yText = yBlock.get('prop:text') as Y.Text | null;
    if (!yText) {
      throw new Error(`Block "${id}" does not have text`);
    }

    const adapter = new RichTextAdapter(this, yText, quill);
    this.richTextAdapters.set(id, adapter);

    quill.on('selection-change', () => {
      const cursor = adapter.getCursor();
      if (!cursor) return;

      this.awarenessAdapter.setLocalCursor(this, { ...cursor, id });
    });
  };

  /** Cancel the connection between the rich text editor instance and YText. */
  detachRichText(id: string) {
    const adapter = this.richTextAdapters.get(id);
    adapter?.destroy();
    this.richTextAdapters.delete(id);
  }

  markTextSplit(base: Text, left: PrelimText, right: PrelimText) {
    this._splitSet.add(base).add(left).add(right);
  }

  syncFromExistingDoc() {
    if (this._synced) {
      throw new Error('Cannot sync from existing doc more than once');
    }

    tryMigrate(this.doc);

    this._handleVersion();
    this._initYBlocks();

    const visited = new Set<string>();

    this._yBlocks.forEach((_, id) => {
      if (visited.has(id)) return;
      visited.add(id);
      this._handleYBlockAdd(visited, id);
    });

    this._synced = true;
  }

  dispose() {
    this.signals.historyUpdated.dispose();
    this.signals.rootAdded.dispose();
    this.signals.rootDeleted.dispose();
    this.signals.textUpdated.dispose();
    this.signals.updated.dispose();

    this._yBlocks.unobserveDeep(this._handleYEvents);
    this._yBlocks.clear();
  }

  private _initYBlocks() {
    const { _yBlocks } = this;
    // Consider if we need to expose the ability to temporarily unobserve this._yBlocks.
    // "unobserve" is potentially necessary to make sure we don't create
    // an infinite loop when sync to remote then back to client.
    // `action(a) -> YDoc' -> YEvents(a) -> YRemoteDoc' -> YEvents(a) -> YDoc'' -> ...`
    // We could unobserve in order to short circuit by ignoring the sync of remote
    // events we actually generated locally.
    // _yBlocks.unobserveDeep(this._handleYEvents);
    _yBlocks.observeDeep(this._handleYEvents);

    this._history = new Y.UndoManager([_yBlocks], {
      trackedOrigins: new Set([this.doc.clientID]),
      doc: this.doc,
    });

    this._history.on('stack-cleared', this._historyObserver);
    this._history.on('stack-item-added', this._historyAddObserver);
    this._history.on('stack-item-popped', this._historyPopObserver);
    this._history.on('stack-item-updated', this._historyObserver);
  }

  private _getYBlock(id: string): YBlock {
    const yBlock = this._yBlocks.get(id) as YBlock | undefined;
    if (!yBlock) {
      throw new Error(`Block with id ${id} does not exist`);
    }
    return yBlock;
  }

  private _historyAddObserver = (event: { stackItem: StackItem }) => {
    if (isWeb) {
      event.stackItem.meta.set(
        'cursor-location',
        this.awarenessAdapter.getLocalCursor(this)
      );
    }

    this._historyObserver();
  };

  private _historyPopObserver = (event: { stackItem: StackItem }) => {
    const cursor = event.stackItem.meta.get('cursor-location');
    if (!cursor) {
      return;
    }

    this.awarenessAdapter.setLocalCursor(this, cursor);
    this._historyObserver();
  };

  private _historyObserver = () => {
    this.signals.historyUpdated.emit();
  };

  private _createBlockModel(props: Omit<BlockProps, 'children'>) {
    const BlockModelCtor = this.workspace.flavourMap.get(props.flavour);
    if (!BlockModelCtor) {
      throw new Error(`Block flavour ${props.flavour} is not registered`);
    } else if (!props.id) {
      throw new Error('Block id is not defined');
    }

    const blockModel = new BlockModelCtor(
      this,
      props as PropsWithId<Omit<BlockProps, 'children'>>
    );
    return blockModel;
  }

  private _handleYBlockAdd(visited: Set<string>, id: string) {
    const yBlock = this._getYBlock(id);
    const isRoot = this._blockMap.size === 0;
    let isSurface = false;

    const prefixedProps = yBlock.toJSON() as PrefixedBlockProps;
    const props = toBlockProps(prefixedProps) as BlockProps;
    const model = this._createBlockModel({ ...props, id });
    if (model.flavour === 'affine:surface') {
      isSurface = true;
    }
    this._blockMap.set(props.id, model);

    if (
      // TODO use schema
      matchFlavours(model, [
        'affine:paragraph',
        'affine:list',
        'affine:code',
      ]) &&
      !yBlock.get('prop:text')
    ) {
      this.transact(() => yBlock.set('prop:text', new Y.Text()));
    }

    const yText = yBlock.get('prop:text') as Y.Text;
    const text = new Text(this, yText);
    model.text = text;
    if (model.flavour === 'affine:page') {
      model.tags = yBlock.get('meta:tags') as Y.Map<Y.Map<unknown>>;
      model.tagSchema = yBlock.get('meta:tags') as Y.Map<unknown>;
    }

    const yChildren = yBlock.get('sys:children');
    if (yChildren instanceof Y.Array) {
      model.childMap = createChildMap(yChildren);

      yChildren.forEach((id: string) => {
        const index = model.childMap.get(id);
        if (Number.isInteger(index)) {
          const hasChild = this._blockMap.has(id);

          if (!hasChild) {
            visited.add(id);
            this._handleYBlockAdd(visited, id);
          }

          const child = this._blockMap.get(id) as BaseBlockModel;
          model.children[index as number] = child;
        }
      });
    }

    if (isRoot) {
      this._root = model;
      this.signals.rootAdded.emit(model);
    } else if (isSurface) {
      this._root = [this.root as BaseBlockModel, model];
      this.signals.rootAdded.emit(this._root);
    } else {
      const parent = this.getParent(model);
      const index = parent?.childMap.get(model.id);
      if (parent && index !== undefined) {
        parent.children[index] = model;
        parent.childrenUpdated.emit();
      }
    }
  }

  private _handleYBlockDelete(id: string) {
    const model = this._blockMap.get(id);
    if (model === this._root) {
      this.signals.rootDeleted.emit(id);
    } else {
      // TODO dispatch model delete event
    }
    this._blockMap.delete(id);
  }

  private _handleYBlockUpdate(event: Y.YMapEvent<unknown>) {
    const id = event.target.get('sys:id') as string;
    const model = this.getBlockById(id);
    if (!model) return;

    const props: Partial<BlockProps> = {};
    let hasPropsUpdate = false;
    let hasChildrenUpdate = false;
    for (const key of event.keysChanged) {
      // TODO use schema
      if (key === 'prop:text') continue;
      // Update children
      if (key === 'sys:children') {
        hasChildrenUpdate = true;
        const yChildren = event.target.get('sys:children');
        if (!(yChildren instanceof Y.Array)) {
          console.error(
            'Failed to update block children!, sys:children is not an Y array',
            event,
            yChildren
          );
          continue;
        }
        model.childMap = createChildMap(yChildren);
        model.children = yChildren.map(
          id => this._blockMap.get(id) as BaseBlockModel
        );
        continue;
      }
      // Update props
      hasPropsUpdate = true;
      props[key.replace('prop:', '')] = event.target.get(key);
    }

    if (hasPropsUpdate) {
      Object.assign(model, props);
      model.propsUpdated.emit();
    }
    hasChildrenUpdate && model.childrenUpdated.emit();
  }

  private _handleYEvent(event: Y.YEvent<YBlock | Y.Text | Y.Array<unknown>>) {
    // event on top-level block store
    if (event.target === this._yBlocks) {
      const visited = new Set<string>();

      event.keys.forEach((value, id) => {
        if (value.action === 'add') {
          // Here the key is the id of the blocks.
          // Generally, the key that appears earlier corresponds to the block added earlier,
          // and it won't refer to subsequent keys.
          // However, when redo the operation that adds multiple blocks at once,
          // the earlier block may have children pointing to subsequent blocks.
          // In this case, although the yjs-side state is correct, the BlockModel instance may not exist yet.
          // Therefore, at this point we synchronize the referenced block first,
          // then mark it in `visited` so that they can be skipped.
          if (visited.has(id)) return;
          visited.add(id);

          this._handleYBlockAdd(visited, id);
        } else if (value.action === 'delete') {
          this._handleYBlockDelete(id);
        } else {
          // fires when undoing delete-and-add operation on a block
          // console.warn('update action on top-level block store', event);
        }
      });
    }
    // event on single block
    else if (event.target.parent === this._yBlocks) {
      if (event instanceof Y.YTextEvent) {
        this.signals.textUpdated.emit(event);
      } else if (event instanceof Y.YMapEvent) {
        this._handleYBlockUpdate(event);
      }
    }
    // event on block field
    else if (
      event.target.parent instanceof Y.Map &&
      event.target.parent.has('sys:id')
    ) {
      if (event instanceof Y.YArrayEvent) {
        const id = event.target.parent.get('sys:id') as string;
        const model = this._blockMap.get(id);
        if (!model) {
          throw new Error(`Block with id ${id} does not exist`);
        }

        const key = event.path[event.path.length - 1];
        if (key === 'sys:children') {
          const childIds = event.target.toArray();
          model.children = childIds.map(
            id => this._blockMap.get(id) as BaseBlockModel
          );
          model.childMap = createChildMap(event.target);
          model.childrenUpdated.emit();
        }
      }
    }
  }

  // Handle all the events that happen at _any_ level (potentially deep inside the structure).
  // So, we apply a listener at the top level for the flat structure of the current
  // page/space container.
  private _handleYEvents = (events: Y.YEvent<YBlock | Y.Text>[]) => {
    for (const event of events) {
      this._handleYEvent(event);
    }
    this.signals.updated.emit();
  };

  private _handleVersion() {
    // Initialization from empty yDoc, indicating that the document is new.
    if (this._yBlocks.size === 0) {
      this.workspace.meta.writeVersion(this.workspace);
    }
    // Initialization from existing yDoc, indicating that the document is loaded from storage.
    else {
      this.workspace.meta.validateVersion(this.workspace);
    }
  }
}

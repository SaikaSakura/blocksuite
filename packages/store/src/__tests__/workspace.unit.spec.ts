/* eslint-disable @typescript-eslint/no-restricted-imports */
// checkout https://vitest.dev/guide/debugging.html for debugging tests

import { assert, describe, expect, it } from 'vitest';
import { BaseBlockModel, Workspace, Page, Generator } from '../index.js';
import type { Signal } from '@blocksuite/global/utils';

// Use manual per-module import/export to support vitest environment on Node.js
import { PageBlockModel } from '../../../blocks/src/page-block/page-model.js';
import { ParagraphBlockModel } from '../../../blocks/src/paragraph-block/paragraph-model.js';
import { ListBlockModel } from '../../../blocks/src/list-block/list-model.js';
import { FrameBlockModel } from '../../../blocks/src/frame-block/frame-model.js';
import { DividerBlockModel } from '../../../blocks/src/divider-block/divider-model.js';
import type { PageMeta } from '../workspace/index.js';
import { assertExists } from './test-utils-dom.js';

function createTestOptions() {
  const idGenerator = Generator.AutoIncrement;
  return { idGenerator };
}

// Create BlockSchema manually
export const BlockSchema = {
  'affine:paragraph': ParagraphBlockModel,
  'affine:page': PageBlockModel,
  'affine:list': ListBlockModel,
  'affine:frame': FrameBlockModel,
  'affine:divider': DividerBlockModel,
} as const;

function serialize(page: Page) {
  return page.doc.toJSON();
}

function waitOnce<T>(signal: Signal<T>) {
  return new Promise<T>(resolve => signal.once(val => resolve(val)));
}

async function createRoot(page: Page) {
  queueMicrotask(() => page.addBlockByFlavour('affine:page'));
  const root = await waitOnce(page.signals.rootAdded);
  return root;
}

async function createPage(workspace: Workspace, pageId = 'page0') {
  queueMicrotask(() => workspace.createPage(pageId));
  await waitOnce(workspace.signals.pageAdded);
  const page = workspace.getPage(pageId);
  assertExists(page);
  return page;
}

async function createTestPage() {
  const options = createTestOptions();
  const workspace = new Workspace(options).register(BlockSchema);
  const page = await createPage(workspace);
  return page;
}

const defaultPageId = 'page0';
const spaceId = `space:${defaultPageId}`;
const spaceMetaId = 'space:meta';

describe.concurrent('basic', () => {
  it('can init workspace', async () => {
    const options = createTestOptions();
    const workspace = new Workspace(options);
    const page = await createPage(workspace);
    const actual = serialize(page);
    const actualPage = actual[spaceMetaId].pages[0] as PageMeta;
    assert.equal(typeof actualPage.createDate, 'number');
    // @ts-ignore
    delete actualPage.createDate;

    assert.deepEqual(actual, {
      [spaceMetaId]: {
        pages: [
          {
            id: 'page0',
            title: '',
          },
        ],
        versions: {},
      },
      [spaceId]: {},
    });
  });
});

describe.concurrent('addBlock', () => {
  it('can add single model', async () => {
    const page = await createTestPage();
    page.addBlockByFlavour('affine:page');

    assert.deepEqual(serialize(page)[spaceId], {
      '0': {
        'meta:tags': {},
        'meta:tagSchema': {},
        'sys:children': [],
        'sys:flavour': 'affine:page',
        'sys:id': '0',
      },
    });
  });

  it('can add model with props', async () => {
    const page = await createTestPage();
    page.addBlockByFlavour('affine:page', { title: 'hello' });

    assert.deepEqual(serialize(page)[spaceId], {
      '0': {
        'meta:tags': {},
        'meta:tagSchema': {},
        'sys:children': [],
        'sys:flavour': 'affine:page',
        'sys:id': '0',
        'prop:title': 'hello',
      },
    });
  });

  it('can add multi models', async () => {
    const page = await createTestPage();
    page.addBlockByFlavour('affine:page');
    page.addBlockByFlavour('affine:paragraph');

    assert.deepEqual(serialize(page)[spaceId], {
      '0': {
        'meta:tags': {},
        'meta:tagSchema': {},
        'sys:children': ['1'],
        'sys:flavour': 'affine:page',
        'sys:id': '0',
      },
      '1': {
        'sys:children': [],
        'sys:flavour': 'affine:paragraph',
        'sys:id': '1',
        'prop:text': '',
        'prop:type': 'text',
      },
    });
  });

  it('can observe signal events', async () => {
    const page = await createTestPage();

    queueMicrotask(() => page.addBlockByFlavour('affine:page'));
    const block = await waitOnce(page.signals.rootAdded);
    assert.ok(block instanceof BlockSchema['affine:page']);
  });

  it('can add block to root', async () => {
    const page = await createTestPage();

    queueMicrotask(() => page.addBlockByFlavour('affine:page'));
    const roots = await waitOnce(page.signals.rootAdded);
    const root = Array.isArray(roots) ? roots[0] : roots;
    assert.ok(root instanceof BlockSchema['affine:page']);

    page.addBlockByFlavour('affine:paragraph');
    assert.ok(root.children[0] instanceof BlockSchema['affine:paragraph']);
    assert.equal(root.childMap.get('1'), 0);

    const serializedChildren = serialize(page)[spaceId]['0']['sys:children'];
    assert.deepEqual(serializedChildren, ['1']);
    assert.equal(root.children[0].id, '1');
  });

  it('can add and remove multi pages', async () => {
    const options = createTestOptions();
    const workspace = new Workspace(options).register(BlockSchema);

    const page0 = await createPage(workspace, 'page0');
    const page1 = await createPage(workspace, 'page1');
    // @ts-ignore
    assert.equal(workspace._pages.size, 2);

    page0.addBlockByFlavour('affine:page');
    workspace.removePage(page0.id);

    // @ts-expect-error
    assert.equal(workspace._pages.size, 1);
    assert.deepEqual(serialize(page0)['space:page0'], {});

    workspace.removePage(page1.id);
    // @ts-expect-error
    assert.equal(workspace._pages.size, 0);
  });

  it('can set page state', async () => {
    const options = createTestOptions();
    const workspace = new Workspace(options).register(BlockSchema);
    workspace.createPage('page0');

    assert.deepEqual(
      workspace.meta.pageMetas.map(({ id, title }) => ({
        id,
        title,
      })),
      [
        {
          id: 'page0',
          title: '',
        },
      ]
    );

    let called = false;
    workspace.meta.pagesUpdated.on(() => {
      called = true;
    });

    workspace.setPageMeta('page0', { favorite: true });
    assert.deepEqual(
      workspace.meta.pageMetas.map(({ id, title, favorite }) => ({
        id,
        title,
        favorite,
      })),
      [
        {
          id: 'page0',
          title: '',
          favorite: true,
        },
      ]
    );
    assert.ok(called);
  });

  it('can set workspace common meta fields', async () => {
    const options = createTestOptions();
    const workspace = new Workspace(options);

    queueMicrotask(() => workspace.meta.setName('hello'));
    await waitOnce(workspace.meta.commonFieldsUpdated);
    assert.deepEqual(workspace.meta.name, 'hello');

    queueMicrotask(() => workspace.meta.setAvatar('gengar.jpg'));
    await waitOnce(workspace.meta.commonFieldsUpdated);
    assert.deepEqual(workspace.meta.avatar, 'gengar.jpg');
  });
});

describe.concurrent('deleteBlock', () => {
  it('can delete single model', async () => {
    const page = await createTestPage();

    page.addBlockByFlavour('affine:page');
    assert.deepEqual(serialize(page)[spaceId], {
      '0': {
        'meta:tags': {},
        'meta:tagSchema': {},
        'sys:children': [],
        'sys:flavour': 'affine:page',
        'sys:id': '0',
      },
    });

    page.deleteBlockById('0');
    assert.deepEqual(serialize(page)[spaceId], {});
  });

  it('can delete model with parent', async () => {
    const page = await createTestPage();
    const roots = await createRoot(page);
    const root = Array.isArray(roots) ? roots[0] : roots;

    page.addBlockByFlavour('affine:paragraph');

    // before delete
    assert.deepEqual(serialize(page)[spaceId], {
      '0': {
        'meta:tags': {},
        'meta:tagSchema': {},
        'sys:children': ['1'],
        'sys:flavour': 'affine:page',
        'sys:id': '0',
      },
      '1': {
        'sys:children': [],
        'sys:flavour': 'affine:paragraph',
        'sys:id': '1',
        'prop:text': '',
        'prop:type': 'text',
      },
    });

    page.deleteBlock(root.children[0]);

    // after delete
    assert.deepEqual(serialize(page)[spaceId], {
      '0': {
        'meta:tags': {},
        'meta:tagSchema': {},
        'sys:children': [],
        'sys:flavour': 'affine:page',
        'sys:id': '0',
      },
    });
    assert.equal(root.children.length, 0);
  });
});

describe.concurrent('getBlock', () => {
  it('can get block by id', async () => {
    const page = await createTestPage();
    const roots = await createRoot(page);
    const root = Array.isArray(roots) ? roots[0] : roots;

    page.addBlockByFlavour('affine:paragraph');
    page.addBlockByFlavour('affine:paragraph');

    const text = page.getBlockById('2') as BaseBlockModel;
    assert.ok(text instanceof BlockSchema['affine:paragraph']);
    assert.equal(root.children.indexOf(text), 1);

    const invalid = page.getBlockById('😅');
    assert.equal(invalid, null);
  });

  it('can get parent', async () => {
    const page = await createTestPage();
    const roots = await createRoot(page);
    const root = Array.isArray(roots) ? roots[0] : roots;

    page.addBlockByFlavour('affine:paragraph');
    page.addBlockByFlavour('affine:paragraph');

    const result = page.getParent(root.children[1]) as BaseBlockModel;
    assert.equal(result, root);

    const invalid = page.getParentById(root.id, root);
    assert.equal(invalid, null);
  });

  it('can get previous sibling', async () => {
    const page = await createTestPage();
    const roots = await createRoot(page);
    const root = Array.isArray(roots) ? roots[0] : roots;

    page.addBlockByFlavour('affine:paragraph');
    page.addBlockByFlavour('affine:paragraph');

    const result = page.getPreviousSibling(root.children[1]) as BaseBlockModel;
    assert.equal(result, root.children[0]);

    const invalid = page.getPreviousSibling(root.children[0]);
    assert.equal(invalid, null);
  });
});

// Inline snapshot is not supported under describe.parallel config
describe('workspace.exportJSX works', async () => {
  it('workspace matches snapshot', async () => {
    const options = createTestOptions();
    const workspace = new Workspace(options).register(BlockSchema);
    const page = await createPage(workspace);

    page.addBlockByFlavour('affine:page', { title: 'hello' });

    expect(workspace.exportJSX()).toMatchInlineSnapshot(`
      <affine:page
        prop:title="hello"
      />
    `);
  });

  it('empty workspace matches snapshot', async () => {
    const options = createTestOptions();
    const workspace = new Workspace(options).register(BlockSchema);
    await createPage(workspace);

    expect(workspace.exportJSX()).toMatchInlineSnapshot('null');
  });

  it('workspace with multiple blocks children matches snapshot', async () => {
    const options = createTestOptions();
    const workspace = new Workspace(options).register(BlockSchema);
    const page = await createPage(workspace);

    page.addBlockByFlavour('affine:page');
    page.addBlockByFlavour('affine:paragraph');
    page.addBlockByFlavour('affine:paragraph');

    expect(workspace.exportJSX()).toMatchInlineSnapshot(/* xml */ `
      <affine:page>
        <affine:paragraph
          prop:type="text"
        />
        <affine:paragraph
          prop:type="text"
        />
      </affine:page>
    `);
  });
});

describe.concurrent('workspace.search works', async () => {
  it('workspace search matching', async () => {
    const options = createTestOptions();
    const workspace = new Workspace(options).register(BlockSchema);
    const page = await createPage(workspace);

    page.addBlockByFlavour('affine:page', { title: 'hello' });

    page.addBlockByFlavour('affine:paragraph', {
      text: new page.Text(
        page,
        '英特尔第13代酷睿i7-1370P移动处理器现身Geekbench，14核心和5GHz'
      ),
    });

    page.addBlockByFlavour('affine:paragraph', {
      text: new page.Text(
        page,
        '索尼考虑移植《GT赛车7》，又一PlayStation独占IP登陆PC平台'
      ),
    });

    const id = page.id.replace('space:', '');

    expect(workspace.search('处理器')).toStrictEqual(new Map([['1', id]]));

    expect(workspace.search('索尼')).toStrictEqual(new Map([['2', id]]));
  });
});

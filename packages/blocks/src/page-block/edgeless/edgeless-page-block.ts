/// <reference types="vite/client" />
import { html, css } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { Disposable, Signal, Page } from '@blocksuite/store';
import type {
  FrameBlockModel,
  MouseMode,
  PageBlockModel,
} from '../../index.js';
import {
  EdgelessBlockChildrenContainer,
  EdgelessHoverRect,
  EdgelessFrameSelectionRect,
} from './components.js';
import {
  BlockHost,
  BLOCK_ID_ATTR,
  hotkey,
  HOTKEYS,
  resetNativeSelection,
} from '../../__internal__/index.js';
import {
  EdgelessSelectionManager,
  BlockSelectionState,
  ViewportState,
  XYWH,
} from './selection-manager.js';
import {
  bindCommonHotkey,
  handleMultiBlockBackspace,
  removeCommonHotKey,
  tryUpdateFrameSize,
} from '../utils/index.js';
import { NonShadowLitElement } from '../../__internal__/utils/lit.js';
import { getService } from '../../__internal__/service.js';
import { styleMap } from 'lit/directives/style-map.js';
import type { SurfaceBlockModel } from '../../surface-block/surface-model.js';
import { SurfaceContainer } from '@blocksuite/phasor';

export interface EdgelessContainer extends HTMLElement {
  readonly page: Page;
  readonly viewport: ViewportState;
  readonly mouseRoot: HTMLElement;
  readonly signals: {
    hoverUpdated: Signal;
    viewportUpdated: Signal;
    updateSelection: Signal<BlockSelectionState>;
    shapeUpdated: Signal;
  };
}

@customElement('affine-edgeless-page')
export class EdgelessPageBlockComponent
  extends NonShadowLitElement
  implements EdgelessContainer, BlockHost
{
  static styles = css`
    .affine-edgeless-page-block-container {
      position: relative;
      box-sizing: border-box;
      overflow: hidden;
      height: 100%;
      font-family: var(--affine-font-family);
      font-size: var(--affine-font-base);
      line-height: var(--affine-line-height-base);
      color: var(--affine-edgeless-text-color);
      font-weight: 400;
    }

    .affine-edgeless-surface-block-container {
      position: absolute;
      width: 100%;
      height: 100%;
    }

    .affine-surface-canvas {
      width: 100%;
      height: 100%;
      position: relative;
      z-index: 1;
      pointer-events: none;
    }
  `;

  flavour = 'edgeless' as const;

  @property()
  showGrid = false;

  @property()
  page!: Page;

  @property()
  readonly = false;

  @property()
  mouseRoot!: HTMLElement;

  @property()
  mouseMode!: MouseMode;

  @property({ hasChanged: () => true })
  pageModel!: PageBlockModel;

  @property({ hasChanged: () => true })
  surfaceModel!: SurfaceBlockModel;

  @query('.affine-surface-canvas')
  private _canvas!: HTMLCanvasElement;

  signals = {
    viewportUpdated: new Signal(),
    updateSelection: new Signal<BlockSelectionState>(),
    hoverUpdated: new Signal(),
    shapeUpdated: new Signal(),
  };

  surface!: SurfaceContainer;

  viewport = new ViewportState();

  getService = getService;

  private _historyDisposable!: Disposable;
  private _selection!: EdgelessSelectionManager;

  private _bindHotkeys() {
    hotkey.addListener(HOTKEYS.BACKSPACE, this._handleBackspace);
    bindCommonHotkey(this.page);
  }

  private _removeHotkeys() {
    hotkey.removeListener([HOTKEYS.BACKSPACE], this.flavour);
    removeCommonHotKey();
  }

  private _handleBackspace = (e: KeyboardEvent) => {
    if (this._selection.blockSelectionState.type === 'single') {
      // const selectedBlock = this._selection.blockSelectionState.selected;
      // if (selectedBlock.flavour === 'affine:shape') {
      //   this.page.captureSync();
      //   this.page.deleteBlock(selectedBlock);
      //   // TODO: cleanup state instead of create a instance
      //   this._selection = new EdgelessSelectionManager(this);
      //   this.signals.updateSelection.emit({
      //     type: 'none',
      //   });
      // } else {
      //   handleMultiBlockBackspace(this.page, e);
      // }
      handleMultiBlockBackspace(this.page, e);
    }
  };

  private _initViewport() {
    const bound = this.mouseRoot.getBoundingClientRect();
    this.viewport.setSize(bound.width, bound.height);

    const frame = this.pageModel.children[0] as FrameBlockModel;
    const [modelX, modelY, modelW, modelH] = JSON.parse(frame.xywh) as XYWH;
    this.viewport.setCenter(modelX + modelW / 2, modelY + modelH / 2);
  }

  private _clearSelection() {
    requestAnimationFrame(() => {
      if (!this._selection.isActive) {
        resetNativeSelection(null);
      }
    });
  }

  private _syncSurfaceViewport() {
    this.surface.renderer.setCenterZoom(
      this.viewport.centerX,
      this.viewport.centerY,
      this.viewport.zoom
    );
  }

  // Should be called in requestAnimationFrame,
  // so as to avoid DOM mutation in SurfaceContainer constructor
  private _initSurface() {
    const { page } = this;
    const yContainer = page.ySurfaceContainer;
    this.surface = new SurfaceContainer(this._canvas, yContainer);
    this._syncSurfaceViewport();
  }

  update(changedProperties: Map<string, unknown>) {
    if (changedProperties.has('mouseRoot') && changedProperties.has('page')) {
      this._selection = new EdgelessSelectionManager(this);
    }
    if (changedProperties.has('mouseMode')) {
      this._selection.mouseMode = this.mouseMode;
    }
    super.update(changedProperties);
  }

  firstUpdated() {
    // TODO: listen to new children
    this.pageModel.children.forEach(frame => {
      frame.propsUpdated.on(() => this._selection.syncBlockSelectionRect());
    });

    this.signals.viewportUpdated.on(() => {
      this.style.setProperty('--affine-zoom', `${this.viewport.zoom}`);

      this._syncSurfaceViewport();

      this._selection.syncBlockSelectionRect();
      this.requestUpdate();
    });
    this.signals.hoverUpdated.on(() => this.requestUpdate());
    this.signals.updateSelection.on(() => this.requestUpdate());
    this.signals.shapeUpdated.on(() => this.requestUpdate());
    this._historyDisposable = this.page.signals.historyUpdated.on(() => {
      this._clearSelection();
      this.requestUpdate();
    });

    this._bindHotkeys();

    tryUpdateFrameSize(this.page, this.viewport.zoom);

    this.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      tryUpdateFrameSize(this.page, this.viewport.zoom);
    });

    requestAnimationFrame(() => {
      this._initViewport();
      this._initSurface();
      this.requestUpdate();
    });

    // XXX: should be called after rich text components are mounted
    this._clearSelection();
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    this.signals.updateSelection.dispose();
    this.signals.viewportUpdated.dispose();
    this.signals.hoverUpdated.dispose();
    this.signals.shapeUpdated.dispose();
    this._historyDisposable.dispose();
    this._selection.dispose();
    this._removeHotkeys();
  }

  render() {
    this.setAttribute(BLOCK_ID_ATTR, this.pageModel.id);

    const childrenContainer = EdgelessBlockChildrenContainer(
      this.pageModel,
      this,
      this.viewport
    );

    const { _selection, viewport } = this;
    const { frameSelectionRect } = _selection;
    const selectionState = this._selection.blockSelectionState;
    const { zoom, viewportX, viewportY } = this.viewport;
    const selectionRect = EdgelessFrameSelectionRect(frameSelectionRect);
    const hoverRect = EdgelessHoverRect(_selection.hoverState, zoom);

    const translateX = -viewportX * zoom;
    const translateY = -viewportY * zoom;

    const gridStyle = {
      backgroundImage:
        'linear-gradient(#cccccc66 1px, transparent 1px),linear-gradient(90deg, #cccccc66 1px, transparent 1px)',
    };
    const defaultStyle = {};
    const style = this.showGrid ? gridStyle : defaultStyle;

    return html`
      <div class="affine-edgeless-surface-block-container">
        <canvas class="affine-surface-canvas"> </canvas>
      </div>
      <div class="affine-edgeless-page-block-container">
        <style>
          .affine-block-children-container.edgeless {
            padding-left: 0;
            position: relative;
            overflow: hidden;
            height: 100%;
            background-size: ${20 * this.viewport.zoom}px
              ${20 * this.viewport.zoom}px;
            background-position: ${translateX}px ${translateY}px;
            background-color: #fff;
          }
        </style>
        <div
          class="affine-block-children-container edgeless"
          style=${styleMap(style)}
        >
          ${childrenContainer}
        </div>
        ${hoverRect} ${selectionRect}
        ${selectionState.type !== 'none'
          ? html`
              <edgeless-selected-rect
                .viewport=${viewport}
                .state=${selectionState}
                .rect=${selectionState.rect}
                .zoom=${zoom}
                .readonly=${this.readonly}
              ></edgeless-selected-rect>
            `
          : null}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'affine-edgeless-page': EdgelessPageBlockComponent;
  }
}

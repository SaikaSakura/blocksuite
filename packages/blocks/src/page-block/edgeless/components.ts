import { html, LitElement, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import { repeat } from 'lit/directives/repeat.js';
import type { BaseBlockModel } from '@blocksuite/store';

import type { FrameBlockModel, RootBlockModel } from '../../index.js';
import type {
  BlockSelectionState,
  HoverState,
  ViewportState,
  XYWH,
} from './selection-manager.js';
import {
  BlockElement,
  BlockHost,
  getBlockById,
} from '../../__internal__/index.js';
import '../../__internal__/index.js';
import {
  PADDING_X,
  PADDING_Y,
  FRAME_MIN_LENGTH,
  getSelectionBoxBound,
} from './utils.js';
import { SHAPE_PADDING } from '../../index.js';

function getCommonRectStyle(
  rect: DOMRect,
  zoom: number,
  isShape = false,
  selected = false
) {
  return {
    position: 'absolute',
    left: rect.x + 'px',
    top: rect.y + 'px',
    width: rect.width + (isShape ? 0 : PADDING_X) * zoom + 'px',
    height: rect.height + (isShape ? 0 : PADDING_Y) * zoom + 'px',
    borderRadius: `${10 * zoom}px`,
    pointerEvents: 'none',
    boxSizing: 'border-box',
    backgroundColor: isShape && selected ? 'var(--affine-selected-color)' : '',
  };
}

export function EdgelessHoverRect(hoverState: HoverState | null, zoom: number) {
  if (!hoverState) return null;
  const rect = hoverState.rect;
  // const isShape = hoverState.block.flavour === 'affine:shape';

  const style = {
    ...getCommonRectStyle(rect, zoom, false),
    border: '1px solid var(--affine-primary-color)',
  };

  return html`
    <div class="affine-edgeless-hover-rect" style=${styleMap(style)}></div>
  `;
}

enum HandleDirection {
  Left = 'left',
  Right = 'right',
  LeftTop = 'left-top',
  LeftBottom = 'left-bottom',
  RightTop = 'right-top',
  RightBottom = 'right-bottom',
}

const directionCursors = {
  [HandleDirection.Right]: 'ew-resize',
  [HandleDirection.Left]: 'ew-resize',
  [HandleDirection.LeftTop]: 'nw-resize',
  [HandleDirection.RightTop]: 'ne-resize',
  [HandleDirection.LeftBottom]: 'sw-resize',
  [HandleDirection.RightBottom]: 'se-resize',
} as const;

function Handle(
  centerX: number,
  centerY: number,
  handleDirection: HandleDirection,
  onMouseDown?: (e: MouseEvent, direction: HandleDirection) => void
) {
  const style = {
    position: 'absolute',
    left: centerX - 6 + 'px',
    top: centerY - 6 + 'px',
    width: '12px',
    height: '12px',
    boxSizing: 'border-box',
    borderRadius: '6px',
    zIndex: '10',
    border: '2px var(--affine-primary-color) solid',
    background: 'white',
    cursor: directionCursors[handleDirection],
  };

  const handlerMouseDown = (e: MouseEvent) => {
    onMouseDown && onMouseDown(e, handleDirection);
  };

  return html`
    <div
      aria-label=${`handle-${handleDirection}`}
      style=${styleMap(style)}
      @mousedown=${handlerMouseDown}
    ></div>
  `;
}

export function EdgelessFrameSelectionRect(rect: DOMRect | null) {
  if (rect === null) return html``;

  const style = {
    left: rect.left + 'px',
    top: rect.top + 'px',
    width: rect.width + 'px',
    height: rect.height + 'px',
  };
  return html`
    <style>
      .affine-edgeless-frame-selection-rect {
        position: absolute;
        background: var(--affine-selected-color);
        z-index: 1;
        pointer-events: none;
      }
    </style>
    <div
      class="affine-edgeless-frame-selection-rect"
      style=${styleMap(style)}
    ></div>
  `;
}

function EdgelessBlockChild(
  model: RootBlockModel,
  host: BlockHost,
  viewport: ViewportState
) {
  const { xywh } = model;
  const isShape = false;
  const { zoom, viewportX, viewportY } = viewport;
  const [modelX, modelY, modelW, modelH] = JSON.parse(xywh) as XYWH;
  const translateX =
    (modelX - viewportX - (isShape ? SHAPE_PADDING / 2 : 0)) * zoom;
  const translateY =
    (modelY - viewportY - (isShape ? SHAPE_PADDING / 2 : 0)) * zoom;

  const style = {
    position: 'absolute',
    transform: `translate(${translateX}px, ${translateY}px) scale(${zoom})`,
    transformOrigin: '0 0',
    width: modelW + (isShape ? SHAPE_PADDING : PADDING_X) + 'px',
    height: modelH + (isShape ? SHAPE_PADDING : PADDING_Y) + 'px',
    padding: isShape ? '0px' : `${PADDING_X / 2}px`,
    background: isShape ? 'transparent' : 'white',
    pointerEvents: isShape ? 'none' : 'all',
    // shape block should always on the top
    zIndex: isShape ? '1' : '0',
  };

  return html`
    <div
      data-test-id=${`affine-edgeless-block-child-${model.id}-container`}
      class="affine-edgeless-block-child"
      style=${styleMap(style)}
    >
      ${BlockElement(model, host, true)}
    </div>
  `;
}

export function EdgelessBlockChildrenContainer(
  model: BaseBlockModel,
  host: BlockHost,
  viewport: ViewportState
) {
  return html`
    ${repeat(
      model.children,
      child => child.id,
      child => EdgelessBlockChild(child as FrameBlockModel, host, viewport)
    )}
  `;
}

@customElement('edgeless-selected-rect')
export class EdgelessSelectedRect extends LitElement {
  @property({ type: Boolean })
  lock!: boolean;

  @property()
  viewport!: ViewportState;

  @property({ type: Number })
  zoom!: number;

  @property({ type: Object })
  state!: BlockSelectionState;

  @property()
  readonly?: boolean = false;

  @property({ type: Object })
  rect!: DOMRect;

  private _dragStartInfo: {
    startMouseX: number;
    startMouseY: number;
    absoluteX: number;
    absoluteY: number;
    width: number;
    height: number;
    direction: HandleDirection;
  } = {
    startMouseX: 0,
    startMouseY: 0,
    absoluteX: 0,
    absoluteY: 0,
    width: 0,
    height: 0,
    direction: HandleDirection.Left,
  };

  private _getHandles(rect: DOMRect, isShape: boolean) {
    if (isShape) {
      const leftTop = [rect.x, rect.y];
      const rightTop = [rect.x + rect.width, rect.y];
      const leftBottom = [rect.x, rect.y + rect.height];
      const rightBottom = [rect.x + rect.width, rect.y + rect.height];
      return html`
        ${Handle(
          leftTop[0],
          leftTop[1],
          HandleDirection.LeftTop,
          this._onHandleMouseDown
        )}
        ${Handle(
          rightTop[0],
          rightTop[1],
          HandleDirection.RightTop,
          this._onHandleMouseDown
        )}
        ${Handle(
          leftBottom[0],
          leftBottom[1],
          HandleDirection.LeftBottom,
          this._onHandleMouseDown
        )}
        ${Handle(
          rightBottom[0],
          rightBottom[1],
          HandleDirection.RightBottom,
          this._onHandleMouseDown
        )}
      `;
    } else {
      let handles: TemplateResult | null = null;
      if (this.state.type === 'none') return handles;
      if (!this.state.active) {
        const leftCenter = [
          rect.x,
          rect.y + rect.height / 2 + (PADDING_Y * this.zoom) / 2,
        ];
        const rightCenter = [
          rect.x + rect.width + PADDING_X * this.zoom,
          rect.y + rect.height / 2 + (PADDING_Y * this.zoom) / 2,
        ];
        const handleLeft = Handle(
          leftCenter[0],
          leftCenter[1],
          HandleDirection.Left,
          this._onHandleMouseDown
        );
        const handleRight = Handle(
          rightCenter[0],
          rightCenter[1],
          HandleDirection.Right,
          this._onHandleMouseDown
        );
        handles = html` ${handleLeft}${handleRight} `;
      }
      return handles;
    }
  }

  private _onHandleMouseDown = (e: MouseEvent, direction: HandleDirection) => {
    // prevent selection action being fired
    e.stopPropagation();
    if (this.state?.type === 'single') {
      const {
        rect,
        selected: { xywh },
      } = this.state;
      const [x, y] = JSON.parse(xywh) as XYWH;
      this._dragStartInfo = {
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        absoluteX: x,
        absoluteY: y,
        // the width of the selected frame may 0 after init use rect.width instead
        width: rect.width,
        height: rect.height,
        direction,
      };
      // parent ele is the edgeless block container
      this.parentElement?.addEventListener('mousemove', this._onDragMove);
      this.parentElement?.addEventListener('mouseup', this._onDragEnd);
    }
  };

  private _onDragMove = (e: MouseEvent) => {
    if (this.state.type === 'single') {
      const { viewport } = this;
      const { selected } = this.state;
      const { xywh } = selected;
      const [x, y, w, h] = JSON.parse(xywh) as XYWH;
      let newX = x;
      let newY = y;
      let newW = w;
      let newH = h;
      const isShape = false;
      const deltaX = this._dragStartInfo.startMouseX - e.clientX;
      const deltaY = this._dragStartInfo.startMouseY - e.clientY;
      const direction = this._dragStartInfo.direction;
      switch (direction) {
        case HandleDirection.RightTop:
          newY = this._dragStartInfo.absoluteY - deltaY / this.zoom;
          newW = (this._dragStartInfo.width - deltaX) / this.zoom;
          newH = (this._dragStartInfo.height + deltaY) / this.zoom;
          break;
        case HandleDirection.LeftBottom:
          newX = this._dragStartInfo.absoluteX - deltaX / this.zoom;
          newW = (this._dragStartInfo.width + deltaX) / this.zoom;
          newH = (this._dragStartInfo.height - deltaY) / this.zoom;
          break;
        case HandleDirection.RightBottom:
          newW = (this._dragStartInfo.width - deltaX) / this.zoom;
          newH = (this._dragStartInfo.height - deltaY) / this.zoom;
          break;
        case HandleDirection.LeftTop: {
          newY = this._dragStartInfo.absoluteY - deltaY / this.zoom;
          newX = this._dragStartInfo.absoluteX - deltaX / this.zoom;
          newW = (this._dragStartInfo.width + deltaX) / this.zoom;
          newH = (this._dragStartInfo.height + deltaY) / this.zoom;
          break;
        }
        case HandleDirection.Left: {
          newX = this._dragStartInfo.absoluteX - deltaX / this.zoom;
          newW = (this._dragStartInfo.width + deltaX) / this.zoom;
          break;
        }
        case HandleDirection.Right: {
          newX = x;
          newW = (this._dragStartInfo.width - deltaX) / this.zoom;
          break;
        }
      }
      // limit the width of the selected frame
      if (newW < FRAME_MIN_LENGTH) {
        newW = FRAME_MIN_LENGTH;
        newX = x;
      }
      // limit the height of the selected frame
      if (newH < FRAME_MIN_LENGTH) {
        newH = FRAME_MIN_LENGTH;
        newY = y;
      }
      // if xywh do not change, no need to update
      if (newW === w && newX === x && newY === y && newW === w) {
        return;
      }
      const frameBlock = getBlockById<'div'>(selected.id);
      const frameContainer = frameBlock?.parentElement;
      // first change container`s x/w directly for get frames real height
      if (frameContainer) {
        frameContainer.style.width = newW + 'px';
        frameContainer.style.translate = `translate(${newX}px, ${newY}px) scale(${this.zoom})`;
      }
      // reset the width of the container may trigger animation
      requestAnimationFrame(() => {
        // refresh xywh by model
        if (!this.lock) {
          selected.page.captureSync();
          this.lock = true;
        }
        if (this.state.type === 'single') {
          this.state.rect = getSelectionBoxBound(viewport, selected.xywh);
        } else {
          console.error('unexpected state.type:', this.state.type);
        }
        const newXywh = JSON.stringify([
          newX,
          newY,
          newW,
          !isShape
            ? (frameBlock?.getBoundingClientRect().height || 0) / this.zoom
            : newH,
        ]);
        selected.xywh = newXywh;
        selected.page.updateBlock(selected, { xywh: newXywh });
      });
    }
  };

  private _onDragEnd = (_: MouseEvent) => {
    this.lock = false;
    if (this.state.type === 'single') {
      this.state.selected.page.captureSync();
    } else {
      console.error('unexpected state.type:', this.state.type);
    }
    this.parentElement?.removeEventListener('mousemove', this._onDragMove);
    this.parentElement?.removeEventListener('mouseup', this._onDragEnd);
  };

  render() {
    if (this.state.type === 'none') return html``;
    // const isShape = this.state.selected.flavour === 'affine:shape';
    const style = {
      border: `${
        this.state.active ? 2 : 1
      }px solid var(--affine-primary-color)`,
      zIndex: '3',
      ...getCommonRectStyle(this.rect, this.zoom, false, true),
    };
    const handlers = this._getHandles(this.rect, false);
    return html`
      ${this.readonly ? null : handlers}
      <div class="affine-edgeless-selected-rect" style=${styleMap(style)}></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'edgeless-selected-rect': EdgelessSelectedRect;
  }
}

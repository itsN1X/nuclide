'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {PanelLocationId, SerializedPanelLocation} from './types';
import type {Viewable} from '../../nuclide-workspace-views/lib/types';

import createPaneContainer from '../../commons-atom/create-pane-container';
import PanelRenderer from '../../commons-atom/PanelRenderer';
import {renderReactRoot} from '../../commons-atom/renderReactRoot';
import {observableFromSubscribeFunction} from '../../commons-node/event';
import UniversalDisposable from '../../commons-node/UniversalDisposable';
import {SimpleModel} from '../../commons-node/SimpleModel';
import {bindObservableAsProps} from '../../nuclide-ui/bindObservableAsProps';
import {observePanes} from './observePanes';
import {syncPaneItemVisibility} from './syncPaneItemVisibility';
import * as PanelLocationIds from './PanelLocationIds';
import {Panel} from './ui/Panel';
import nullthrows from 'nullthrows';
import {React} from 'react-for-atom';
import {BehaviorSubject, Observable} from 'rxjs';

type State = {
  visible: boolean,
};

/**
 * Manages views for an Atom panel.
 */
export class PanelLocation extends SimpleModel<State> {
  _disposables: IDisposable;
  _paneContainer: atom$PaneContainer;
  _panes: BehaviorSubject<Set<atom$Pane>>;
  _panelRenderer: PanelRenderer;
  _position: 'top' | 'right' | 'bottom' | 'left';
  _size: ?number;

  constructor(locationId: PanelLocationId, serializedState: Object = {}) {
    super();
    (this: any)._handlePanelResize = this._handlePanelResize.bind(this);
    const serializedData = serializedState.data || {};
    this._paneContainer = deserializePaneContainer(serializedData.paneContainer);
    this._position = nullthrows(locationsToPosition.get(locationId));
    this._panelRenderer = new PanelRenderer({
      priority: 101, // Use a value higher than the default (100).
      location: this._position,
      createItem: this._createItem.bind(this),
    });
    this._panes = new BehaviorSubject(new Set());
    this._size = serializedData.size || null;
    this.state = {
      visible: serializedData.visible === true,
    };
  }

  /**
   * Set up the subscriptions and make this thing "live."
   */
  initialize(): void {
    const paneContainer = this._paneContainer;

    // Create a stream that represents a change in the items of any pane. We need to do custom logic
    // for this instead of using `PaneContainer::observePaneItems()`, or the other PaneContainer
    // item events, because those [assume that moved items are not switching pane containers][1].
    // Since we have multiple pane containers, they can.
    //
    // [1]: https://github.com/atom/atom/blob/v1.10.0/src/pane-container.coffee#L232-L236
    const paneItemChanges = this._panes
      .map(x => Array.from(x))
      .switchMap(panes => {
        const itemChanges: Array<Observable<mixed>> = panes.map(pane => (
          Observable.merge(
            observableFromSubscribeFunction(pane.onDidAddItem.bind(pane)),
            observableFromSubscribeFunction(pane.onDidRemoveItem.bind(pane)),
          )
        ));
        return Observable.merge(...itemChanges);
      });

    this._disposables = new UniversalDisposable(
      this._panelRenderer,

      observePanes(paneContainer).subscribe(this._panes),

      syncPaneItemVisibility(
        this._panes,
        // $FlowFixMe: Teach Flow about Symbol.observable
        Observable.from(this)
          .map(state => state.visible)
          .distinctUntilChanged(),
      ),

      // Add a tab bar to any panes created in the container.
      paneContainer.observePanes(pane => {
        const tabBarView = document.createElement('ul', 'atom-tabs');

        // This should always be true. Unless they don't have atom-tabs installed or something. Do
        // we need to wait for activation of atom-tabs?
        if (typeof tabBarView.initialize !== 'function') { return; }

        tabBarView.initialize(pane);
        const paneElement = atom.views.getView(pane);
        paneElement.insertBefore(tabBarView, paneElement.firstChild);
      }),

      // Render whenever the state changes. Note that state is shared between this instance and the
      // pane container, so we have to watch it as well.
      Observable.merge(
        paneItemChanges,
        // $FlowIssue: We need to teach flow about Symbol.observable.
        Observable.from(this).map(state => state.visible).distinctUntilChanged(),
      )
        .subscribe(() => { this._render(); }),

    );
  }

  _render() {
    // Only show the panel if it's supposed to be visible *and* there are items to show in it
    // (even if `core.destroyEmptyPanes` is `false`).
    const shouldBeVisible = this.state.visible && this._paneContainer.getPaneItems().length > 0;
    this._panelRenderer.render({visible: shouldBeVisible});
  }

  _createItem(): Object {
    // Create an item to display in the panel. Atom will associate this item with a view via the
    // view registry (and its `getElement` method). That view will be used to display views for this
    // panel.
    // $FlowIssue: We need to teach flow about Symbol.observable.
    const props = Observable.from(this).map(state => ({
      initialSize: this._size,
      item: this._paneContainer,
      position: this._position,
      onResize: this._handlePanelResize,
    }));
    const Component = bindObservableAsProps(props, Panel);
    return {getElement: () => renderReactRoot(<Component />)};
  }

  _handlePanelResize(size: number): void {
    // If the user resizes the pane, store it so that we can serialize it for the next session.
    this._size = size;
  }

  itemIsVisible(item: Viewable): boolean {
    if (!this.state.visible) {
      return false;
    }
    for (const pane of this._panes.getValue()) {
      if (item === pane.getActiveItem()) {
        return true;
      }
    }
    return false;
  }

  destroy(): void {
    this._disposables.dispose();
    this._paneContainer.destroy();
  }

  destroyItem(item: Object): void {
    for (const pane of this._panes.getValue()) {
      for (const it of pane.getItems()) {
        if (it === item) {
          pane.destroyItem(it);
        }
      }
    }
  }

  getItems(): Array<Viewable> {
    const items = [];
    for (const pane of this._panes.getValue()) {
      items.push(...pane.getItems());
    }
    return items;
  }

  showItem(item: Viewable): void {
    let pane = this._paneContainer.paneForItem(item);
    if (pane == null) {
      pane = this._paneContainer.getActivePane();
      pane.addItem(item);
    }
    pane.activate();
    pane.activateItem(item);
    this.setState({visible: true});
  }

  /**
   * Hide the specified item. If the user toggles a visible item, we hide the entire pane.
   */
  hideItem(item: Viewable): void {
    const itemIsVisible = this._paneContainer.getPanes()
      .some(pane => pane.getActiveItem() === item);

    // If the item's already hidden, we're done.
    if (!itemIsVisible) {
      return;
    }

    // Otherwise, hide the panel altogether.
    this.setState({visible: false});
  }

  isVisible(): boolean {
    return this.state.visible;
  }

  toggle(): void {
    this.setState({visible: !this.state.visible});
  }

  serialize(): ?SerializedPanelLocation {
    return {
      deserializer: 'PanelLocation',
      data: {
        paneContainer: this._paneContainer == null ? null : this._paneContainer.serialize(),
        size: this._size,
        visible: this.state.visible,
      },
    };
  }
}

function deserializePaneContainer(serialized: ?Object): atom$PaneContainer {
  const paneContainer = createPaneContainer();
  if (serialized != null) {
    paneContainer.deserialize(serialized, atom.deserializers);
  }
  return paneContainer;
}

const locationsToPosition = new Map([
  [PanelLocationIds.TOP_PANEL, 'top'],
  [PanelLocationIds.RIGHT_PANEL, 'right'],
  [PanelLocationIds.BOTTOM_PANEL, 'bottom'],
  [PanelLocationIds.LEFT_PANEL, 'left'],
]);

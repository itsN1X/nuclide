'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {DistractionFreeModeProvider} from '../../nuclide-distraction-free-mode';
import type {GetToolBar} from '../../commons-atom/suda-tool-bar';
import type {TaskRunnerServiceApi} from '../../nuclide-task-runner/lib/types';
import type {CwdApi} from '../../nuclide-current-working-directory/lib/CwdApi';
import type {OutputService} from '../../nuclide-console/lib/types';

import PanelRenderer from '../../commons-atom/PanelRenderer';
import UniversalDisposable from '../../commons-node/UniversalDisposable';
import {Disposable} from 'atom';
import {React, ReactDOM} from 'react-for-atom';
import invariant from 'assert';
import HhvmIcon from './ui/HhvmIcon';
import HhvmBuildSystem from './HhvmBuildSystem';
import NuclideToolbar from './NuclideToolbar';
import ProjectStore from './ProjectStore';

class Activation {

  _disposables: UniversalDisposable;
  _projectStore: ProjectStore;
  _state: Object;
  _buildSystem: ?HhvmBuildSystem;
  _cwdApi: ?CwdApi;
  _panelRenderer: PanelRenderer;

  constructor(state: ?Object) {
    this._state = {
      panelVisible: state != null && state.panelVisible != null ? state.panelVisible : true,
    };
    this._disposables = new UniversalDisposable();
    this._projectStore = new ProjectStore();
    this._addCommands();
    this._disposables.add(
      this._panelRenderer = new PanelRenderer({
        location: 'top',
        createItem: this._createPanelItem.bind(this),
        // Increase priority (default is 100) to ensure this toolbar comes after the 'tool-bar'
        // package's toolbar. Hierarchically the controlling toolbar should be above, and
        // practically this ensures the popover in this build toolbar stacks on top of other UI.
        priority: 200,
      }),
    );
    this._renderToolbar();
  }

  setCwdApi(cwdApi: ?CwdApi) {
    this._cwdApi = cwdApi;
    if (this._buildSystem != null) {
      this._buildSystem.setCwdApi(cwdApi);
    }
  }

  _addCommands(): void {
    this._disposables.add(
      atom.commands.add(
        'body',
        'nuclide-hhvm-toolbar:toggle',
        () => { this.togglePanel(); },
      ),
    );
  }

  _renderToolbar(): void {
    this._panelRenderer.render({visible: this._state.panelVisible});
  }

  consumeToolBar(getToolBar: GetToolBar): IDisposable {
    const toolBar = getToolBar('nuclide-hhvm-toolbar');
    const {element} = toolBar.addButton({
      callback: 'nuclide-hhvm-toolbar:toggle',
      tooltip: 'Toggle HHVM Toolbar',
      priority: 500,
    });
    toolBar.addSpacer({
      priority: 501,
    });
    ReactDOM.render(
      <div className="hhvm-toolbar-icon-container">
        <HhvmIcon width="37%" />
      </div>,
      element,
    );
    const disposable = new Disposable(() => {
      ReactDOM.unmountComponentAtNode(element);
      toolBar.removeItems();
    });
    this._disposables.add(disposable);
    return disposable;
  }

  consumeBuildSystemRegistry(registry: TaskRunnerServiceApi): void {
    this._disposables.add(registry.register(this._getBuildSystem()));
  }

  consumeOutputService(api: OutputService): void {
    this._disposables.add(
      api.registerOutputProvider({
        id: 'Arc Build',
        messages: this._getBuildSystem().getOutputMessages(),
      }),
    );
  }

  _getBuildSystem(): HhvmBuildSystem {
    if (this._buildSystem == null) {
      const buildSystem = new HhvmBuildSystem();
      if (this._cwdApi != null) {
        buildSystem.setCwdApi(this._cwdApi);
      }
      this._buildSystem = buildSystem;
    }
    return this._buildSystem;
  }


  getDistractionFreeModeProvider(): DistractionFreeModeProvider {
    return {
      name: 'nuclide-hhvm-toolbar',
      isVisible: () => this._state.panelVisible,
      toggle: () => this.togglePanel(),
    };
  }

  _createPanelItem() {
    const disposables = new UniversalDisposable();
    let element;
    return {
      getElement: () => {
        if (element == null) {
          element = document.createElement('div');
          ReactDOM.render(<NuclideToolbar projectStore={this._projectStore} />, element);
          disposables.add(() => {
            ReactDOM.unmountComponentAtNode(element);
          });
        }
        return element;
      },
      destroy() {
        disposables.dispose();
      },
    };
  }

  serialize(): Object {
    return {
      panelVisible: this._state.panelVisible,
    };
  }

  dispose() {
    this._projectStore.dispose();
    this._disposables.dispose();
  }

  togglePanel(): void {
    this._state.panelVisible = !this._state.panelVisible;
    this._renderToolbar();
  }
}

let activation: ?Activation = null;

export function activate(state: ?Object) {
  if (!activation) {
    activation = new Activation(state);
  }
}

export function consumeBuildSystemRegistry(registry: TaskRunnerServiceApi): void {
  invariant(activation);
  activation.consumeBuildSystemRegistry(registry);
}

export function consumeCwdApi(api: CwdApi): IDisposable {
  invariant(activation);
  activation.setCwdApi(api);
  return new Disposable(() => {
    if (activation != null) {
      activation.setCwdApi(null);
    }
  });
}

export function consumeToolBar(getToolBar: GetToolBar): IDisposable {
  invariant(activation);
  return activation.consumeToolBar(getToolBar);
}

export function getDistractionFreeModeProvider(): DistractionFreeModeProvider {
  invariant(activation != null);
  return activation.getDistractionFreeModeProvider();
}

export function consumeOutputService(api: OutputService): void {
  invariant(activation != null);
  activation.consumeOutputService(api);
}

export function deactivate() {
  if (activation != null) {
    activation.dispose();
    activation = null;
  }
}

export function serialize(): Object {
  if (activation != null) {
    return activation.serialize();
  } else {
    return {};
  }
}

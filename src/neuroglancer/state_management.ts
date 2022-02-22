import {registerActionListener} from 'neuroglancer/util/event_action_map';

registerActionListener(document.getElementsByTagName("body")[0], 'undo', () => {
  StateHistory.pop();
});

class StateStack {
  private stack: StateRecord[]

  constructor() {
    this.stack = [];
  }

  push(record: any, callback: Function) {
    this.stack.push(new StateRecord(record, callback));
  }

  pop() {
    let state = this.stack.pop();
    if (state) {
      state.callback(state.record);
    }

    return state;
  }
}

class StateRecord {
  callback:Function;
  record:any;

  constructor(record: any, callback: Function) {
    this.callback = callback;
    this.record = record;
  }
}

export const StateHistory = new StateStack();
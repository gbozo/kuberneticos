// @flow
import * as React from "react";
import WindowApp from './WindowApp';
import WMStore from '../stores/WMStore';
import WMActions from '../actions/WMActions';
import TaskBar from "./TaskBar";


export default class WindowManager extends React.Component {
  
  constructor(props) {
    super(props);
    this.state = {
        windows:WMStore.getAll()
    };
    this._onChange = this._onChange.bind(this);
    this.createWindow = this.createWindow.bind(this);
  }
  componentDidMount() {
    WMStore.addChangeListener('STORE_ADD_WINDOW',this._onChange);
    WMStore.addChangeListener('STORE_REMOVE_WINDOW',this._onChange);
  };

  componentWillUnmount() {
    WMStore.removeChangeListener('STORE_ADD_WINDOW',this._onChange);
    WMStore.removeChangeListener('STORE_REMOVE_WINDOW',this._onChange);
  };

  _onChange() {
    console.log("onchange");
    this.setState({
      windows: WMStore.getAll()
    },()=>{
      console.log("state set",this.state.windows);
      //this.forceUpdate();
    });
  };
  
  createWindow(windowApp) {
    WMActions.addWindow(windowApp);
};
  render() {
    const {windows} = this.state;
    console.log("render wm",windows,windows.length);
    var cWindows = this.state.windows.map(w => {
      console.log("window",w);
      const {id, component} = w;
      return <WindowApp key={id} id={id} component={component}/>;
    });
    return (
        <React.Fragment> 
          {cWindows}
          <TaskBar windows={cWindows}/>
        </React.Fragment>
      )
}
}
import * as React from "react";
import * as PropTypes from "prop-types";

import AppBarButton from "react-uwp/AppBarButton";
import AppBarSeparator from "react-uwp/AppBarSeparator";
import Startmenu from "./StartMenu";
import TaskBarClock from "./TaskBarClock";
import TaskBarWindows from "./TaskBarWindows";
import WMActions from '../actions/WMActions';
import WMStore from '../stores/WMStore';

const TaskBarWrapperStyle: React.CSSProperties = {
  height: "auto",
  display: "block",
  margin: 0,
  position: "fixed",
  bottom: "0px",
  width: "100%",
  zIndex: 1100
};
const TaskBarStyle: React.CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "row",
  alignItems: "flex-start",
  justifyContent: "space-between",
  fontSize: "14px",
  color: "rgba(255, 255, 255, 0.8)",
  background: "#000000",
  height: "48px",
  transition: "all .125s ease-in-out",
}
const TaskBarContentStyle: React.CSSProperties = {
  height: "48px",
  lineHeight: "48px",
  paddingLeft: "10px",
  paddingRight: "10px",
  background: "transparent"
}
const TaskBarCommandStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "flex-start",
  height: "100%"
}
export default class TaskBar extends React.Component {
    static contextTypes = { theme: PropTypes.object };
    context: { theme: ReactUWP.ThemeType };
    
    constructor(props) {
      super(props);
  
      this.state = {    
        showStartMenu:false,
        focusWindow:null
      };
  
      this.showHideStartMenu = this.showHideStartMenu.bind(this);
      this._onFocusChange = this._onFocusChange.bind(this);
    }
    componentDidMount() {
      WMStore.addChangeListener('STORE_FOCUS_WINDOW_CHANGED',this._onFocusChange);
    };
  
    componentWillUnmount() {
      WMStore.removeChangeListener('STORE_FOCUS_WINDOW_CHANGED',this._onFocusChange);
    };
    _onFocusChange() {
      console.log("taskbar onFocuschange");
      this.setState({
        focusWindow: WMStore.getFocusedWindow
      });
    };
  showHideStartMenu(){
      this.setState(prevState => ({
        showStartMenu: !prevState.showStartMenu
      }),()=>{
        if (this.state.showStartMenu){
          WMActions.showStartMenu();
        } else {
          WMActions.hideStartMenu();
        }
      });
  }
  render() {
    //const { theme } = this.context;
       
    return (
      <React.Fragment>
      <div style={TaskBarWrapperStyle}>
        <div style={TaskBarStyle}> 
          <div style={TaskBarCommandStyle}>
          <AppBarSeparator style={{margin:0}}/>
            <AppBarButton icon="AllApps" label="Start" onClick={this.showHideStartMenu}/>
            <AppBarSeparator style={{margin:0}}/>
            <AppBarButton icon="Connect" label="Test"/>
            <AppBarSeparator style={{margin:0}}/>
            <AppBarButton icon="DirectAccess" label="Test"/>
          </div>
          <div style={TaskBarCommandStyle}>
          <TaskBarWindows windows={this.props.windows} focusWindow={this.state.focusWindow}/>
          </div>
          <div style={TaskBarContentStyle}><TaskBarClock/></div>          

        </div>
      </div>
      <Startmenu/>

      </React.Fragment>
    );
  }
}

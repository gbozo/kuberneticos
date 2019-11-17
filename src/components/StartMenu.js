import * as React from "react";
import * as PropTypes from "prop-types";

import NavigationView from "react-uwp/NavigationView";
import SplitViewCommand from "react-uwp/SplitViewCommand";
import WMActions from '../actions/WMActions';
import WMStore from '../stores/WMStore';
import ListView from "react-uwp/ListView";
import Separator from "react-uwp/Separator";
import CheckBox from "react-uwp/CheckBox";
import Toggle from "react-uwp/Toggle";



const StartMenuWrapperStyle: React.CSSProperties = {
    bottom: "48px",
    position: "absolute",
    minHeight: "240px",
    display: "flex",
    zIndex:1050,
    
}
const baseStyle: React.CSSProperties = {
  margin:  0,textAlign:"left"
};
// const StartMenuStyle: React.CSSProperties = {
    
// }
const navigationTopNodes = [
    <SplitViewCommand icon={"\uE716"} />,
    <SplitViewCommand label="Print" icon="PrintLegacy" />
];


export default class StartMenu extends React.Component {
    static contextTypes = { theme: PropTypes.object };
    context: { theme: ReactUWP.ThemeType };
    
    constructor(props) {
      super(props);
      this.state = {
        show:false
      };
      this._showStartMenu = this._showStartMenu.bind(this);
      this._hideStartMenu = this._hideStartMenu.bind(this);
      this.createWindow = this.createWindow.bind(this);
    }
    componentDidMount() {
      WMStore.addChangeListener('STORE_SHOW_STARTMENU',this._showStartMenu);
      WMStore.addChangeListener('STORE_HIDE_STARTMENU',this._hideStartMenu);
    }
  
    componentWillUnmount() {
      WMStore.removeChangeListener('STORE_SHOW_STARTMENU',this._showStartMenu);
      WMStore.removeChangeListener('STORE_HIDE_STARTMENU',this._hideStartMenu);
    }
    _showStartMenu() {
      this.setState({
        show: true
      })
    }
    _hideStartMenu() {
      this.setState({
        show: false
      })
    }
    createWindow(windowApp) {
      WMActions.addWindow(windowApp);
  };
    render() {
       // const { theme } = this.context;
        return (
        <div style={StartMenuWrapperStyle}>
          {this.state.show ? (
          <NavigationView
            isControlled
            isTenFt={true}
            style={{ width: 640, height: 640 }}
            pageTitle="Kubernetic OS"
            displayMode="overlay"
            autoResize={true}
            defaultExpanded
            navigationTopNodes={navigationTopNodes}
            navigationBottomNodes={[
              <SplitViewCommand label="Settings" icon={"\uE713"} />,
              <SplitViewCommand label="CalendarDay" icon={"\uE161"} onClick={() => {
                this.createWindow("TestWindow")
                WMActions.hideStartMenu()
              }}/>
          ]}
            focusNavigationNodeIndex={2}
          >
           <div 
              style={{ height:"100%",textAlign:"right",objectFit: "cover",backgroundImage:"url(\""+require("../assets/jennifer-bailey-10753.1DE91.jpg")+"\")" }}>
            <ListView
          listSource={[{
            itemNode: <p>Text</p>
          }, {
            itemNode: <Separator />,
            disabled: true
          }, ...Array(12).fill(0).map((numb, index) => (
            <span key={`${index}`}>
              <span>Confirm{index + 1}</span>
              <Toggle background="none" style={{ float: "right" }} />
            </span>
          )),
            <span>
              <span>Confirm</span>
              <CheckBox background="none" style={{ float: "right" }} />
            </span>
          ]}
          style={baseStyle}
        />
            </div>
        </NavigationView>) : null}
        </div>
      )
    }
}
// @flow
import * as React from "react";
import * as PropTypes from "prop-types";
import { Rnd } from 'react-rnd';

import Icon from "react-uwp/Icon";
import Separator from "react-uwp/Separator";
import WMActions from '../actions/WMActions';
import WMStore from '../stores/WMStore';

const zIndexOver=1000
const zIndexUnder=1

export default class Window extends React.Component {
  static contextTypes = { theme: PropTypes.object };
  context: { theme: ReactUWP.ThemeType };
  
  constructor(props) {
    super(props);
    this.state = { visible: 1, minimized:0 , focus:0, width:360,height:200};
    this.getFocus = this.getFocus.bind(this);
    this.getBlur = this.getBlur.bind(this);
    this.handleMinimizeWindow = this.handleMinimizeWindow.bind(this);
    this.handleCloseWindow = this.handleCloseWindow.bind(this);
    this._onChangeFocusMessage = this._onChangeFocusMessage.bind(this);
  }
  componentDidMount() {
    WMStore.addChangeListener('STORE_FOCUS_WINDOW_CHANGED',this._onChangeFocusMessage);
  };

  componentWillUnmount() {
    WMStore.removeChangeListener('STORE_FOCUS_WINDOW_CHANGED',this._onChangeFocusMessage);
  };
  _onChangeFocusMessage(a) {
    console.log("_onChangeFocusMessage",a,this.props);
    
    if (a[0].id===this.props.id) {
      if (!this.state.focus) this.setState({
        focus:1
      })
    } else {
      if (this.state.focus) this.setState({
        focus:0
      })
    }
  };
  getFocus(e) {
    WMActions.focusWindow(this.props.id)
    console.log("window.fire.focus",e)
   }
   getBlur(e) {
    console.log("window.fire.blur",e)
    if (this.state.focus) this.setState({
      focus:0
    })
   } 
  handleMinimizeWindow() {
    if (!this.state.minimized) this.setState({
      minimized:1,
      height:30
    })
    console.log("window state",this.props.id,this.state)
    console.log("window state",this.props.id,this.state)
  }
  handleCloseWindow() {
    WMActions.removeWindow(this.props.id)
  }
  render() {
    console.log("render window",this.state,this.props);
    const { theme } = this.context;
    if ( !this.state.visible) return null;

    const rootStyles = theme.prefixStyle({
        display: "flex",
        flexDirection: "row",
        alignItems: "center"
    });
    const titleStyle = theme.prefixStyle({
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "flex-start",
        height: 32,
        width: "100%",
        margin: "0",
        padding: 8,
        fontSize: "1em",
        background: this.state.focus?theme.chromeMedium:theme.acrylicTexture60.background,
        cursor: "default"
        });
    return (
        <div style={rootStyles} onClick={this.getFocus} onFocus={this.getFocus} onBlur={this.getBlur}>
        <Rnd ref={c => { this.rnd = c }}
        // className="wind"
        dragHandleClassName="windowDragHandle"
        minHeight={30}
        minWidth={250}
        dragGrid={[5,5]}
        size={{ width: this.state.width,  height: this.state.height }}
        onResizeStart={this.getFocus}
        onResizeStop={(e, direction, ref, delta, position) => {
          this.setState({
            width: ref.style.width,
            height: ref.style.height,
            ...position,
          });
        }}
        default={{
          x: 0,
          y: 0,
          width: 360,
          height: 200
        }}
          style={{
            background: this.state.focus?theme.chromeMedium:theme.acrylicTexture60.background,
            boxShadow: "rgba(0, 0, 0, 0.2) 2px 2px 8px 3px",
            overflow:"hidden",
            zIndex:this.state.focus?zIndexOver:zIndexUnder
          }}
          onDragStart={this.getFocus}
        >
        <div style={titleStyle} className="windowDragHandle">
            
              <Icon style={{ fontSize: "12px" }}>FolderLegacy</Icon>
            
            <Separator direction="column" style={{margin: "0.5em"}}/>
           
            {this.props.title}
                       
            <Icon style={{ fontSize: "11px", position:"fixed",right: "120px" }} onClick={this.handleMinimizeWindow}>ChromeMinimize</Icon>
            <Icon style={{ fontSize: "11px", position:"fixed",right: "70px" }}>ChromeMaximize</Icon>
            <Icon style={{ fontSize: "11px", position:"fixed",right: "20px" }} onClick={this.handleCloseWindow}>ChromeClose</Icon>
        </div>
       {this.props.children}
      </Rnd>
    </div>      
    );
  }
}
Window.defaultProps = {
  title: 'Untitled Window'
};
import * as React from "react";
import * as PropTypes from "prop-types";
import Tooltip from "react-uwp/Tooltip";
import AppBarButton from "react-uwp/AppBarButton";
import AppBarSeparator from "react-uwp/AppBarSeparator";

export default class TaskBarWindows extends React.Component {
    static contextTypes = { theme: PropTypes.object };
    context: { theme: ReactUWP.ThemeType };
  
    constructor(props) {
      super(props);
      this.state = {
        
      };
    }
    componentDidMount() {
      
    }
    componentWillUnmount() {
      
    }
   
    render() {
      const {windows} = this.props;
    console.log("taskbar render wm",windows,windows.length);
    var taskWindows = windows.map(w => {
      const {id, component} = w;
      console.log("taskabr render",w)
      return <AppBarButton key={w.key+"taskbarwindow"} icon="FolderLegacy" label="App"  labelPosition="right"
          hoverStyle={{ background: "yellowgreen" }} style={{ background: this.props.focusWindow && this.props.focusWindow.id===w.id?"darkgray":"blue" }}/>
    });
    return (
        <React.Fragment> 
          {taskWindows}
        </React.Fragment>
      )
}
  }
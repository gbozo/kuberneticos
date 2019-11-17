// @flow
import * as React from "react";
import * as PropTypes from "prop-types";
import Icon from "react-uwp/Icon";
import Toggle from "react-uwp/Toggle";
import AutoSuggestBox from "react-uwp/AutoSuggestBox"

export default class TestWindowApp extends React.Component {
  static contextTypes = { theme: PropTypes.object };
  context: { theme: ReactUWP.ThemeType };
  constructor(props) {
    super(props);
    this.title="Test Application window";

    this.state = {    
        toggle1:false
    };

    this.onToggle = this.onToggle.bind(this);
  }

  componentDidMount(){
    //this.props.onTitle(this.title);
  }
  onToggle(toggleState){
    this.setState(prevState => ({
      toggle1: toggleState
    }))
    return toggleState;
  }

  render() {
    const { theme } = this.context;
    const rootStyles = theme.prefixStyle({
        display: "flex",
        flexDirection: "row",
        alignItems: "center"
    });
    console.log("render testapp -> Toggle=",this.state.toggle1);
    return (
        <div style={rootStyles}>
           <Icon>ChromeMinimize</Icon>
           <Toggle onToggle={this.onToggle} defaultToggled={this.state.toggle1}>test toggle</Toggle>
           <AutoSuggestBox />
        </div>      
    );
  }
}

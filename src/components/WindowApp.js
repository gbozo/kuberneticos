// @flow
import * as React from "react";
import Window from './Window';

export default class WindowApp extends React.Component {
    render() {
        console.log("render windowapp",this.props)
        if (!this.props.component) return null;
        const NewApp = this.props.component
      return (
        <Window title={NewApp.title} id={this.props.id} onFocus={this.getFocus} onBlur={this.getBlur}>
            <NewApp/>
        </Window>
      );
    }
  }
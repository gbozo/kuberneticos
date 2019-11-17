import * as React from "react";
import * as PropTypes from "prop-types";
import Tooltip from "react-uwp/Tooltip";

export default class Clock extends React.Component {
    static contextTypes = { theme: PropTypes.object };
    context: { theme: ReactUWP.ThemeType };
  
    constructor(props) {
      super(props);
      this.state = {
        time: new Date()
      };
    }
    componentDidMount() {
      this.intervalID = setInterval(
        () => this.tick(),
        1000
      );
    }
    componentWillUnmount() {
      clearInterval(this.intervalID);
    }
    tick() {
      this.setState({
        time: new Date()
      });
    }
    render() {
      var now=this.state.time;
      var isPM = now.getHours() >= 12;
      var isMidday = now.getHours() === 12;
      var time = [now.getHours() - (isPM && !isMidday ? 12 : 0), 
        now.getMinutes()<10?"0"+now.getMinutes():now.getMinutes()].join(':') +
           (isPM ? ' PM' : 'AM');
      return (
        <div>
            <Tooltip key="TaskbarClock" content={now.toLocaleString()} margin={20}>
                {time}
            </Tooltip>
        </div>
      );
    }
  }
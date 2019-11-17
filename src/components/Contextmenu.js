import * as React from "react";
import * as PropTypes from "prop-types";

import Menu, { MenuItem } from "react-uwp/Menu";
import Separator from "react-uwp/Separator";

const baseStyle: React.CSSProperties = {
  margin: "0px 0",
  display: "inline-block",
  verticalAlign: "middle",
  position:"absolute"
};

export default class ContextMenu extends React.Component {
    static contextTypes = { theme: PropTypes.object };
    context: { theme: ReactUWP.ThemeType };
  
    state = {
        visible: false,
    };
    
    componentDidMount() {
        document.addEventListener('contextmenu', this._handleContextMenu);
        document.addEventListener('click', this._handleClick);
        document.addEventListener('scroll', this._handleScroll);
    };

    componentWillUnmount() {
      document.removeEventListener('contextmenu', this._handleContextMenu);
      document.removeEventListener('click', this._handleClick);
      document.removeEventListener('scroll', this._handleScroll);
    }
    
    _handleContextMenu = (event) => {
        event.preventDefault();
        console.log("context menu",event)
        this.setState({ visible: true });
        
        const clickX = event.clientX;
        const clickY = event.clientY;
        const screenW = window.innerWidth;
        const screenH = window.innerHeight;
        const rootW = this.root.offsetWidth;
        const rootH = this.root.offsetHeight;
        
        const right = (screenW - clickX) > rootW;
        const left = !right;
        const top = (screenH - clickY) > rootH;
        const bottom = !top;
        
        if (right) {
            this.root.style.left = `${clickX }px`;
        }
        
        if (left) {
            this.root.style.left = `${clickX - rootW }px`;
        }
        
        if (top) {
            this.root.style.top = `${clickY }px`;
        }
        
        if (bottom) {
            this.root.style.top = `${clickY - rootH }px`;
        }
    };

    _handleClick = (event) => {
        const { visible } = this.state;
        const wasOutside = !(event.target.contains === this.root);
        
        if (wasOutside && visible) this.setState({ visible: false, });
    };

    _handleScroll = () => {
        const { visible } = this.state;
        
        if (visible) this.setState({ visible: false, });
    };
    
    render() {
        const { visible } = this.state;
        let menu;

        if (visible) {
            menu=<div ref={ref => {this.root = ref}} style={baseStyle}>
            <Menu menuItemHeight={36} expandedMethod="hover">
            <MenuItem
              icon="Share"
              label="Share"
            />
            <MenuItem
              icon="Copy"
              label="Copy"
            />
            <MenuItem
              icon="Delete"
              label="Delete"
            />
            <Separator />
            <MenuItem label="Rename" />
            <MenuItem label="Select" />
            <MenuItem label="Child Menu">
              <MenuItem label="Rename">
                <MenuItem
                  label="Test"
                />
              </MenuItem>
              <MenuItem
                icon="Delete"
                label="Delete"
              />
            </MenuItem>
            </Menu>
          </div>
        } else {
            menu=null;
        }
        
        return(
        <React.Fragment>
            {this.props.children}
            {menu}   
        </React.Fragment>);
        
        
    };
}


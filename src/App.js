import React, { Component } from 'react';
import { Theme as UWPThemeProvider, getTheme } from 'react-uwp/Theme';

import './assets/App.css';
import ContextMenu from "./components/Contextmenu";
import WindowManager from './components/WindowManager';

class App extends Component {
  render() {
    return (
      <UWPThemeProvider
      theme={getTheme({
        themeName: 'dark', // set custom theme
        accent: '#0078D7', // set accent color
        useFluentDesign: true, // sure you want use new fluent design.
        desktopBackgroundImage: require('./assets/airport-center-computing-236093.jpg') // set global desktop background image
      })}
    >
      <WindowManager/>
      <ContextMenu/>
      </UWPThemeProvider>
    );
  }
}

export default App;

import WMDispatcher from '../dispatcher/WMDispatcher';
import { EventEmitter } from 'events';
import shortid from "shortid";

// import TestWindow from "../WindowApps/TestWindow";

let apps=["TestWindow"]
let _windows = []
let _windowFocused = null
let _windowApps=[]

class AppStore extends EventEmitter {

    constructor() {
        super();
        this.dispatchToken = WMDispatcher.register(this.dispatcherCallback.bind(this));
        this.addWindowApps = this.addWindowApps.bind(this);
        this.addWindowApps(apps);
    }

    emitChange(eventName,...args) {
        this.emit(eventName,args);
    }

    getAll() {
      return _windows
    }

    getFocusedWindow() {
      return _windowFocused;
    }

    addWindow(windowApp) {
      let id=shortid.generate()
      _windows.push({id:id,component: this.findWindowApp(windowApp)})
      this.focusWindow(id)
    }

    removeWindow(id)
    {
      console.log("remove window id",id)
      let wid=this.findWindow(id)
      console.log("remove window id",id,wid)
      _windows.splice(wid,1);
      if (_windowFocused.id===wid) _windowFocused=null 
    }

    focusWindow(id) {
      console.log("focuswindow",_windowFocused,id)
      if (_windowFocused){
        if (_windowFocused.id===id) return false
        _windowFocused=_windows[this.findWindow(id)]
      } else {
        _windowFocused=_windows[this.findWindow(id)]
      }
      return true
    }
    findWindowApp(windowApp){
      console.log(_windowApps,windowApp);
      let windowAppInstance=_windowApps.find(function(app) {
        return app.name === windowApp;
      });
      return windowAppInstance.component
    }
    addWindowApps(windowApps) {
      windowApps.forEach(windowApp=>{
        this.addWindowApp(windowApp);
      })
    }
    async addWindowApp(windowApp) {
      
      import(`../WindowApps/${windowApp}.js`)
          .then(componentApp =>
            _windowApps.push({name:windowApp,component: componentApp.default})
            
          )
          .catch(error => {
            console.error(`"${windowApp}" not yet supported`);
          });
      
    }
    findWindow(id){
      return _windows.findIndex(w => w.id===id);
      
    }
    getWindow(id){
      
      let window=_windows.find((window)=> {
        return window.id === id;
      });
      return window
    }
    addChangeListener(eventName, callback) {
        this.on(eventName, callback);
    }

    removeChangeListener(eventName, callback) {
        this.removeListener(eventName, callback);
    }

    dispatcherCallback(action) {
      
        switch (action.actionType) {
            case 'ADD_WINDOW':
                this.addWindow(action.value);
                break;
            case 'FOCUS_WINDOW':
                if (this.focusWindow(action.value)) this.emitChange('STORE_' + action.actionType + "_CHANGED",_windowFocused)
                break;
            case 'REMOVE_WINDOW':
                this.removeWindow(action.value);
                break;
            case 'SHOW_STARTMENU':  
                break;
            case 'HIDE_STARTMENU':                
                break;
            default:
              console.log("action not implemented",action)
        }
        
        this.emitChange('STORE_' + action.actionType,action.value);

        return true;
    }
}

export default new AppStore();
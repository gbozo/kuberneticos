import WMDispatcher from '../dispatcher/WMDispatcher';

class WMActions {
    
    addWindow(data) {
        WMDispatcher.dispatch({
            actionType: 'ADD_WINDOW',
            value: data
        });
    }

    removeWindow(key)
    {
        WMDispatcher.dispatch({
            actionType: 'REMOVE_WINDOW',
            value: key
        });
    }
    focusWindow(key){
        WMDispatcher.dispatch({
            actionType: 'FOCUS_WINDOW',
            value: key
        });
    }
    showStartMenu(){
        WMDispatcher.dispatch({
            actionType: 'SHOW_STARTMENU',
            value: null
        });
    }
    hideStartMenu(){
        WMDispatcher.dispatch({
            actionType: 'HIDE_STARTMENU',
            value: null
        });
    }

}

export default new WMActions() 
import {COMMAND, EVENT} from "../enum.js";
import $, {$div} from "../util/dom.js";
import ImageProcessing from "../util/imageProcessing.js";
import ImageFile from "../image.js";
import EventBus from "../util/eventbus.js";
import Palette from "./palette.js";
import LayerPanel from "./toolPanels/layerPanel.js";
import FramesPanel from "./toolPanels/framesPanel.js";
import BrushPanel from "./toolPanels/brushPanel.js";
import ColorPicker from "./components/colorPicker.js";
import GridPanel from "./toolPanels/gridPanel.js";
import UserSettings from "../userSettings.js";

var BottomPanel = function(){
    let me = {}
    let container;
    let innerContainer;

    let panels = {
        frames:{
            label: "Frames",
            height: 130,
            content: parent=>{
                FramesPanel.generate(parent);
            }
        }
    }

    me.init = parent=>{
        container = $(".bottompanel",{
                parent: parent
            },
            innerContainer=$(".panelcontainer")
        );
        generate();

        if (UserSettings.get("bottompanel")){
            setTimeout(()=>{
                me.show();
            },50);
        }
    }

    me.show = (section)=>{
        UserSettings.set("bottompanel",true);
        container.classList.add("active");
        EventBus.trigger(EVENT.panelUIChanged);
    }

    me.hide = ()=>{
        UserSettings.set("bottompanel",false);
        container.classList.remove("active");
        EventBus.trigger(EVENT.panelUIChanged);
    }

    me.toggle = ()=>{
        UserSettings.set("bottompanel",!me.isVisible());
        container.classList.toggle("active",me.isVisible());
        EventBus.trigger(EVENT.panelUIChanged);
    }

    me.isVisible = ()=>{
        return !!UserSettings.get("bottompanel");
    }

    function generate(){
        Object.keys(panels).forEach(key=>{
            let panel = panels[key];
            panel.container = generatePanel(panel,innerContainer);
        })
    }

    function generatePanel(panelInfo,parent){
        let panel = $div("panel " + panelInfo.label.toLowerCase() + (panelInfo.collapsed?' collapsed':''),"",parent);
        let caption = $div("caption","<i></i> " + panelInfo.label,panel,()=>{
            panelInfo.collapsed = !panelInfo.collapsed;
        });
        let close = $div("close info","x",caption,()=>EventBus.trigger(COMMAND.TOGGLEBOTTOMPANEL));
        close.info = "Close Bottom panels";
        let inner = $div("inner","",panel);
        let w;
        if (panelInfo.content){
            panelInfo.content(inner);
        }
        return panel;
    }

    EventBus.on(COMMAND.TOGGLEBOTTOMPANEL,me.toggle);

    return me;
}()

export default BottomPanel;

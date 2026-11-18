package dev.boujoy.personalagent;

import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;

/** Moves only a remembered root task. No launch/restart operation exists in this interface. */
final class HandoffTaskMover {
    record Root(int taskId,int displayId,int userId,int position,boolean visible,String packageName) {}
    interface Platform {
        List<Root> roots(int displayId)throws Exception;
        Root focused()throws Exception;
        void move(int rootTaskId,int displayId)throws Exception;
        void focus(int rootTaskId)throws Exception;
    }
    interface Sleeper {void sleep(long ms)throws InterruptedException;}
    static Root select(List<Root> roots,int displayId,String excludedPackage){
        Root best=null;
        for(Root root:roots){
            if(root.displayId()!=displayId||displayId<=0||root.taskId()<0||!root.visible()||root.packageName()==null||root.packageName().isBlank()||root.packageName().equals(excludedPackage))continue;
            if(best==null||root.position()>best.position())best=root;
            else if(root.position()==best.position()&&root.taskId()!=best.taskId())throw new IllegalStateException("HANDOFF_TARGET_AMBIGUOUS");
        }
        if(best==null)throw new IllegalStateException("HANDOFF_TARGET_MISSING");return best;
    }
    static Root find(List<Root> roots,Root target){
        for(Root root:roots)if(root.taskId()==target.taskId()&&root.userId()==target.userId()&&root.packageName().equals(target.packageName()))return root;
        return null;
    }
    static boolean confirmed(Root target,List<Root> main,Root focused){
        Root actual=find(main,target);
        return actual!=null&&actual.displayId()==0&&actual.visible()&&focused!=null&&focused.displayId()==0
                &&focused.taskId()==target.taskId()&&focused.userId()==target.userId()&&focused.packageName().equals(target.packageName());
    }
    static void moveAndConfirm(Platform platform,Root target,int source,BooleanSupplier beforeMove,BooleanSupplier stillLive,
            LongSupplier clock,Sleeper sleeper)throws Exception {
        Root held=find(platform.roots(source),target),main=find(platform.roots(0),target);
        if(held==null&&main==null)throw new IllegalStateException("HANDOFF_TARGET_MISSING");
        if(!beforeMove.getAsBoolean())throw new IllegalStateException("HANDOFF_NOT_ALLOWED");
        if(held!=null)platform.move(target.taskId(),0);
        // This focus applies only to the exact moved root; a retry never launches a replacement.
        if(!stillLive.getAsBoolean())throw new IllegalStateException("HANDOFF_CANCELLED");
        main=find(platform.roots(0),target);
        if(main!=null&&!confirmed(target,platform.roots(0),platform.focused())){
            if(!stillLive.getAsBoolean())throw new IllegalStateException("HANDOFF_CANCELLED");
            platform.focus(target.taskId());
        }
        long end=clock.getAsLong()+1500;
        do{
            if(!stillLive.getAsBoolean())throw new IllegalStateException("HANDOFF_CANCELLED");
            if(confirmed(target,platform.roots(0),platform.focused()))return;
            if(clock.getAsLong()>=end)break;sleeper.sleep(80);
        }while(true);
        throw new IllegalStateException("HANDOFF_MOVE_UNCONFIRMED");
    }
}

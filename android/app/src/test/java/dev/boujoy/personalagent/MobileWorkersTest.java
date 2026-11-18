package dev.boujoy.personalagent;
import java.util.concurrent.*;import org.junit.Test;import static org.junit.Assert.*;
public class MobileWorkersTest {
    @Test public void stalledPollAndDownloadCannotDelayLocalPersistenceControlOrConversationHistory()throws Exception{
        try(MobileWorkers lanes=new MobileWorkers()){
            CountDownLatch polling=new CountDownLatch(1),downloading=new CountDownLatch(1),release=new CountDownLatch(1);
            lanes.connection.execute(()->{polling.countDown();try{release.await();}catch(InterruptedException e){Thread.currentThread().interrupt();}});
            lanes.files.execute(()->{downloading.countDown();try{release.await();}catch(InterruptedException e){Thread.currentThread().interrupt();}});
            assertTrue(polling.await(2,TimeUnit.SECONDS));assertTrue(downloading.await(2,TimeUnit.SECONDS));
            assertEquals("sent",lanes.messages.submit(()->"sent").get(2,TimeUnit.SECONDS));
            assertEquals("durable",lanes.persistence.submit(()->"durable").get(2,TimeUnit.SECONDS));assertEquals("stop",lanes.control.submit(()->"stop").get(2,TimeUnit.SECONDS));assertEquals("history",lanes.history.submit(()->"history").get(2,TimeUnit.SECONDS));release.countDown();
        }
    }
    @Test public void staleReceiptAndNotificationTimeoutCannotBlockFreshStateOrExplicitMessage()throws Exception{
        try(MobileWorkers lanes=new MobileWorkers()){
            CountDownLatch entered=new CountDownLatch(2),release=new CountDownLatch(1);
            Runnable blocked=()->{entered.countDown();try{release.await();}catch(InterruptedException e){Thread.currentThread().interrupt();}};
            lanes.receipts.execute(blocked);lanes.notifications.execute(blocked);assertTrue(entered.await(2,TimeUnit.SECONDS));
            try{assertEquals("online",lanes.connection.submit(()->"online").get(2,TimeUnit.SECONDS));assertEquals("explicit",lanes.messages.submit(()->"explicit").get(2,TimeUnit.SECONDS));assertEquals("stop",lanes.control.submit(()->"stop").get(2,TimeUnit.SECONDS));}
            finally{release.countDown();}
        }
    }
    @Test public void displayLongPollCannotBlockTypingStateOrLocalStop()throws Exception{
        try(MobileWorkers lanes=new MobileWorkers()){
            CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);
            lanes.display.execute(()->{entered.countDown();try{release.await();}catch(InterruptedException e){Thread.currentThread().interrupt();}});
            assertTrue(entered.await(2,TimeUnit.SECONDS));
            try{assertEquals("state",lanes.connection.submit(()->"state").get(2,TimeUnit.SECONDS));assertEquals("typing",lanes.typing.submit(()->"typing").get(2,TimeUnit.SECONDS));assertEquals("stop",lanes.control.submit(()->"stop").get(2,TimeUnit.SECONDS));}
            finally{release.countDown();}
        }
    }
    @Test public void telemetryAndNotificationReportsCannotDelayMaintenanceOrUserControl()throws Exception{
        try(MobileWorkers lanes=new MobileWorkers()){
            CountDownLatch entered=new CountDownLatch(2),release=new CountDownLatch(1);
            Runnable blocked=()->{entered.countDown();try{release.await();}catch(InterruptedException e){Thread.currentThread().interrupt();}};
            lanes.telemetry.execute(blocked);lanes.notifications.execute(blocked);assertTrue(entered.await(2,TimeUnit.SECONDS));
            try{assertEquals("restored",lanes.maintenance.submit(()->"restored").get(2,TimeUnit.SECONDS));assertEquals("stop",lanes.control.submit(()->"stop").get(2,TimeUnit.SECONDS));assertEquals("online",lanes.connection.submit(()->"online").get(2,TimeUnit.SECONDS));}
            finally{release.countDown();}
        }
    }
    @Test public void stalledRearLaunchCannotBlockStateDisplayOrLocalStop()throws Exception{
        MobileWorkers lanes=new MobileWorkers();
        try(lanes){
            CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);
            lanes.rearProgress.execute(()->{entered.countDown();try{release.await();}catch(InterruptedException e){Thread.currentThread().interrupt();}});
            assertTrue(entered.await(2,TimeUnit.SECONDS));
            try{assertEquals("state",lanes.connection.submit(()->"state").get(2,TimeUnit.SECONDS));assertEquals("display",lanes.display.submit(()->"display").get(2,TimeUnit.SECONDS));assertEquals("stop",lanes.control.submit(()->"stop").get(2,TimeUnit.SECONDS));}
            finally{release.countDown();}
        }
        assertTrue(lanes.rearProgress.isShutdown());
    }
}

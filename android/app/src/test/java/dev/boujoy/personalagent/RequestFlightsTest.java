package dev.boujoy.personalagent;
import java.util.*;import java.util.concurrent.*;import org.junit.Test;import static org.junit.Assert.*;
public class RequestFlightsTest {
    @Test public void concurrentDuplicateTapsStartExactlyOneRequestUntilTheReceipt()throws Exception{
        RequestFlights flight=new RequestFlights();ExecutorService pool=Executors.newFixedThreadPool(4);
        try{List<Future<Boolean>> results=new ArrayList<>();for(int n=0;n<24;n++)results.add(pool.submit(()->flight.begin("same-task")));int accepted=0;for(Future<Boolean> result:results)if(result.get(2,TimeUnit.SECONDS))accepted++;
            assertEquals(1,accepted);assertEquals(List.of("same-task"),flight.snapshot());flight.end("same-task");assertTrue(flight.begin("same-task"));assertTrue(flight.begin("different-task"));assertTrue(flight.contains("same-task"));
        }finally{pool.shutdownNow();}
    }
}

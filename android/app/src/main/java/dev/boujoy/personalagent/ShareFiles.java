package dev.boujoy.personalagent;

import android.content.*;
import android.net.Uri;
import android.os.Binder;
import org.json.*;
import java.io.*;
import java.util.*;

/** Private, short-lived payloads. Only the exact named target receives a read-only URI. */
final class ShareFiles {
    private final ConnectionService service;
    private final SecureStore store;
    private final File directory;
    private JSONObject active,ledger;
    private File payload;
    ShareFiles(ConnectionService service,SecureStore store)throws Exception{
        this.service=service;this.store=store;directory=new File(service.getNoBackupFilesDir(),"share-payloads");directory.mkdirs();
        File[] leftovers=directory.listFiles();if(leftovers!=null)for(File file:leftovers)file.delete();ledger=store.read("share-dispatches");
    }
    synchronized JSONObject active()throws Exception{
        if(active==null)return null;
        if(!service.sharePermitted(active)){invalidate();return null;}
        return new JSONObject(active.toString());
    }
    synchronized void stage(JSONObject job,byte[] bytes)throws Exception{
        if(active!=null&&active.optString("jobId").equals(job.optString("jobId")))return;
        if(ledger.has(job.getString("jobId")))throw new IOException("此附件已经尝试交接，不能自动重放");
        ShareJob.validate(job,service.shareEpoch(),service.shareNow());ShareJob.verifyBytes(job,bytes);
        if(!service.sharePermitted(job))throw new IOException("附件交接已被暂停");
        invalidate();File next=new File(directory,job.getString("jobId"));
        try(FileOutputStream out=new FileOutputStream(next)){out.write(bytes);out.getFD().sync();}
        if(!service.sharePermitted(job)){next.delete();throw new IOException("附件交接已被暂停");}
        active=new JSONObject(job.toString()).put("status","prepared");payload=next;
    }
    synchronized boolean known(String jobId){return ledger.has(jobId);}
    synchronized JSONObject reserve(String id)throws Exception{
        JSONObject job=active();if(job==null||!id.equals(job.getString("jobId"))||!"prepared".equals(job.optString("status"))||ledger.has(id))throw new IOException("此附件不能重复交接");
        job.put("status","dispatching").put("dispatchAttemptId",Protocol.id());
        // The durable attempt is recorded BEFORE either the server reservation or the Intent.
        ledger.put(id,Tunnel.json("status","dispatching","dispatchAttemptId",job.getString("dispatchAttemptId"),"at",System.currentTimeMillis()));
        if(ledger.length()>256){List<String> keys=new ArrayList<>();ledger.keys().forEachRemaining(keys::add);keys.sort(Comparator.comparingLong(k->ledger.optJSONObject(k).optLong("at")));for(int i=0;i<keys.size()-256;i++)ledger.remove(keys.get(i));}
        store.write("share-dispatches",ledger);active=job;return new JSONObject(job.toString());
    }
    synchronized Uri uri(JSONObject job)throws Exception{
        JSONObject live=active();if(live==null||!live.getString("jobId").equals(job.getString("jobId"))||!live.getString("dispatchAttemptId").equals(job.getString("dispatchAttemptId")))throw new IOException("附件交接已失效");
        return new Uri.Builder().scheme("content").authority(service.getPackageName()+".attachments").appendPath(live.getString("jobId")).appendPath(live.getString("ticket")).build();
    }
    synchronized void dispatched(JSONObject job)throws Exception{
        JSONObject live=active();if(live==null||!live.getString("jobId").equals(job.getString("jobId")))throw new IOException("附件结果需要核实");
        active.put("status","intent_dispatched");ledger.getJSONObject(job.getString("jobId")).put("status","intent_dispatched");store.write("share-dispatches",ledger);
    }
    synchronized void opened(JSONObject job)throws Exception{JSONObject live=active();if(live!=null&&live.getString("jobId").equals(job.getString("jobId")))active.put("contentOpened",true);}
    synchronized JSONObject checked(Uri uri)throws Exception{
        JSONObject job=active();if(job==null||!Set.of("dispatching","intent_dispatched").contains(job.optString("status"))||!uri.equals(uri(job)))throw new FileNotFoundException("附件授权已失效");
        String[] packages=service.getPackageManager().getPackagesForUid(Binder.getCallingUid());
        if(packages==null||!Arrays.asList(packages).contains(job.getString("targetPackage")))throw new SecurityException("附件只对指定 App 开放");
        return job;
    }
    synchronized File payload(Uri uri)throws Exception{checked(uri);if(payload==null||!payload.isFile())throw new FileNotFoundException();return payload;}
    synchronized void invalidate(){
        if(active!=null)try{Uri uri=new Uri.Builder().scheme("content").authority(service.getPackageName()+".attachments").appendPath(active.getString("jobId")).appendPath(active.getString("ticket")).build();service.revokeUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION);}catch(Exception ignored){}
        if(payload!=null)payload.delete();active=null;payload=null;
    }
}

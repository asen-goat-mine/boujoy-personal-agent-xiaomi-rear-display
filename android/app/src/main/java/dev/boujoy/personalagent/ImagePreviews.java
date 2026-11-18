package dev.boujoy.personalagent;

import android.graphics.*;
import android.os.*;
import android.util.LruCache;
import org.json.JSONObject;
import java.io.*;
import java.util.*;

/** Activity-scoped, bounded decoded previews; download/decode stay on the file worker. */
final class ImagePreviews implements AutoCloseable {
    interface Downloader {void download(String id,ConnectionService.Outcome<File> callback);}
    private final Downloader downloader;
    private final Handler main=new Handler(Looper.getMainLooper());
    private final LruCache<String,Bitmap> cache=new LruCache<>(16*1024*1024){@Override protected int sizeOf(String key,Bitmap image){return image.getAllocationByteCount();}};
    private final Map<String,List<ConnectionService.Outcome<Bitmap>>> pending=new HashMap<>();
    private boolean closed;
    ImagePreviews(Downloader downloader){this.downloader=downloader;}
    static String mime(JSONObject artifact){
        String mime=artifact.optString("mime").toLowerCase(Locale.ROOT);
        if(mime.startsWith("image/")||mime.startsWith("video/"))return mime;
        String name=artifact.optString("name").toLowerCase(Locale.ROOT);
        for(String suffix:new String[]{"png","jpg","jpeg","webp","gif","heic","heif","bmp"})if(name.endsWith("."+suffix))return "image/"+(suffix.equals("jpg")?"jpeg":suffix);
        if(name.endsWith(".mp4")||name.endsWith(".m4v"))return "video/mp4";
        if(name.endsWith(".webm"))return "video/webm";
        if(name.endsWith(".mov"))return "video/quicktime";
        return mime;
    }
    static Bitmap decode(File file)throws IOException{
        BitmapFactory.Options options=new BitmapFactory.Options();options.inJustDecodeBounds=true;BitmapFactory.decodeFile(file.getAbsolutePath(),options);
        if(options.outWidth<=0||options.outHeight<=0)throw new IOException("图片格式暂不支持，请保存原图查看");
        options.inSampleSize=1;while(options.outWidth/options.inSampleSize>1600||options.outHeight/options.inSampleSize>1600)options.inSampleSize*=2;
        options.inJustDecodeBounds=false;Bitmap bitmap=BitmapFactory.decodeFile(file.getAbsolutePath(),options);
        if(bitmap==null)throw new IOException("图片无法读取，请重试");return bitmap;
    }
    void load(JSONObject artifact,ConnectionService.Outcome<Bitmap> callback){
        if(closed)return;String key=artifact.optString("id")+":"+artifact.optString("sha256");Bitmap cached=cache.get(key);
        if(cached!=null){callback.done(cached,null);return;}
        if(pending.containsKey(key)){pending.get(key).add(callback);return;}
        pending.put(key,new ArrayList<>(List.of(callback)));
        downloader.download(artifact.optString("id"),(file,error)->{
            Bitmap bitmap=null;Exception failure=error;
            try{if(failure==null)bitmap=decode(file);}catch(Exception e){failure=e;}finally{if(file!=null)file.delete();}
            Bitmap result=bitmap;Exception problem=failure;
            main.post(()->{List<ConnectionService.Outcome<Bitmap>> callbacks=pending.remove(key);if(closed)return;if(result!=null)cache.put(key,result);if(callbacks!=null)for(var cb:callbacks)cb.done(result,problem);});
        });
    }
    @Override public void close(){closed=true;cache.evictAll();pending.clear();}
}

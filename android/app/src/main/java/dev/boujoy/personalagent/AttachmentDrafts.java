package dev.boujoy.personalagent;

import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import org.json.*;
import java.io.*;
import java.util.*;

/** File bytes stay in private storage; draft/outbox JSON carries only small references. */
public final class AttachmentDrafts {
    public static long limit(String mime){return (mime!=null&&mime.startsWith("video/")?500L:50L)*1024*1024;}
    private static File root(Context context)throws IOException{File root=new File(context.getFilesDir(),"chat-attachments");if(!root.isDirectory()&&!root.mkdirs())throw new IOException("无法准备附件目录");return root;}
    public static File file(Context context,JSONObject row)throws IOException{String id=row.optString("localId");if(!id.matches("[a-f0-9-]{36}"))throw new IOException("附件编号无效，请重新选择");File file=new File(root(context),id);if(!file.isFile()||file.length()!=row.optLong("size"))throw new IOException("附件已失效，请重新选择");return file;}
    public static JSONObject read(Context context,Uri uri)throws Exception{
        String name="附件",mime=context.getContentResolver().getType(uri);if(mime==null||!mime.matches("[\\w.+-]+/[\\w.+-]+"))mime="application/octet-stream";
        try(Cursor cursor=context.getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)){if(cursor!=null&&cursor.moveToFirst())name=cursor.getString(0);}
        if(name==null||name.isBlank())name="附件";if(name.length()>200)name=name.substring(0,200);
        File dir=root(context);long used=0;File[] old=dir.listFiles();if(old!=null)for(File f:old){if(System.currentTimeMillis()-f.lastModified()>2L*86400000)f.delete();else used+=f.length();}
        String id=UUID.randomUUID().toString();File file=new File(dir,id);long size=0;boolean complete=false;
        try(InputStream in=context.getContentResolver().openInputStream(uri);OutputStream out=new FileOutputStream(file)){
            if(in==null)throw new IOException("无法打开附件");byte[] buffer=new byte[32768];int n;while((n=in.read(buffer))!=-1){size+=n;if(size>limit(mime)||size+used>600L*1024*1024)throw new IOException("视频最多 500 MB，其他文件 50 MB，待发送合计 600 MB");out.write(buffer,0,n);}if(size==0)throw new IOException("附件为空");complete=true;
        }finally{if(!complete)file.delete();}
        return Tunnel.json("localId",id,"name",name,"mime",mime,"size",size);
    }
    public static JSONArray persistable(JSONArray rows){JSONArray result=new JSONArray();if(rows!=null)for(int i=0;i<Math.min(10,rows.length());i++){JSONObject row=rows.optJSONObject(i);if(row!=null&&row.optString("localId").matches("[a-f0-9-]{36}"))result.put(Tunnel.json("localId",row.optString("localId"),"name",row.optString("name"),"mime",row.optString("mime"),"size",row.optLong("size")));}return result;}
    public static String label(JSONObject row){long size=row.optLong("size");return row.optString("name","附件")+(size<=0?"":size<1024?" · "+size+" B":size<1048576?String.format(java.util.Locale.ROOT," · %.1f KB",size/1024.0):String.format(java.util.Locale.ROOT," · %.1f MB",size/1048576.0));}
}

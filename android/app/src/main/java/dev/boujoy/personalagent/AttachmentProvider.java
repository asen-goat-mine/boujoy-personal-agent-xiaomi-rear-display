package dev.boujoy.personalagent;

import android.content.*;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import org.json.JSONObject;
import java.io.*;

public final class AttachmentProvider extends ContentProvider {
    @Override public boolean onCreate(){return true;}
    private ConnectionService service()throws FileNotFoundException{ConnectionService value=ConnectionService.current;if(value==null)throw new FileNotFoundException("连接已停止");return value;}
    @Override public ParcelFileDescriptor openFile(Uri uri,String mode)throws FileNotFoundException{
        if(!"r".equals(mode))throw new SecurityException("只允许读取附件");
        try{ConnectionService service=service();JSONObject job=service.shareFiles.checked(uri);File file=service.shareFiles.payload(uri);ParcelFileDescriptor fd=ParcelFileDescriptor.open(file,ParcelFileDescriptor.MODE_READ_ONLY);service.shareContentOpened(job);return fd;}
        catch(FileNotFoundException e){throw e;}catch(Exception e){throw new FileNotFoundException("附件已失效或不是指定 App");}
    }
    @Override public String getType(Uri uri){try{return service().shareFiles.checked(uri).getString("mime");}catch(Exception e){throw new SecurityException("附件已失效");}}
    @Override public Cursor query(Uri uri,String[] projection,String selection,String[] args,String sort){try{
        JSONObject job=service().shareFiles.checked(uri);MatrixCursor cursor=new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE});cursor.addRow(new Object[]{job.getString("name"),job.getLong("size")});return cursor;
    }catch(Exception e){throw new SecurityException("附件已失效");}}
    @Override public Uri insert(Uri uri,ContentValues values){throw new SecurityException("不允许写入");}
    @Override public int update(Uri uri,ContentValues values,String selection,String[] args){throw new SecurityException("不允许写入");}
    @Override public int delete(Uri uri,String selection,String[] args){throw new SecurityException("不允许写入");}
}

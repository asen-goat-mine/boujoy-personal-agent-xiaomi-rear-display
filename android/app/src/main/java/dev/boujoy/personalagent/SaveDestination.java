package dev.boujoy.personalagent;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;

/** Cleans up only a document proved empty before this save began. */
final class SaveDestination {
    static boolean isEmpty(ContentResolver resolver,Uri uri){
        try(Cursor cursor=resolver.query(uri,new String[]{OpenableColumns.SIZE},null,null,null)){
            return cursor!=null&&cursor.moveToFirst()&&!cursor.isNull(0)&&cursor.getLong(0)==0;
        }catch(Exception ignored){return false;}
    }
    static boolean cleanup(ContentResolver resolver,Uri uri,boolean initiallyEmpty){
        if(!initiallyEmpty)return false;
        try{if(DocumentsContract.deleteDocument(resolver,uri))return true;}catch(Exception ignored){}
        try{return resolver.delete(uri,null,null)>0;}catch(Exception ignored){return false;}
    }
    private SaveDestination(){}
}

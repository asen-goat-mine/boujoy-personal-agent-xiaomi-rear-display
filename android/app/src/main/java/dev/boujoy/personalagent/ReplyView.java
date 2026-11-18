package dev.boujoy.personalagent;

import android.content.Context;
import android.graphics.Typeface;
import android.view.View;
import android.widget.*;
import java.util.*;

/** Native text and tables only: no HTML, scripts, remote images or navigation. */
final class ReplyView {
    static View create(Context context,String source,boolean literal){
        LinearLayout body=UiSheet.column(context);
        if(literal){body.addView(text(context,source,false));return body;}
        String[] lines=source.split("\n",-1);StringBuilder paragraph=new StringBuilder();
        for(int i=0;i<lines.length;i++){
            String line=lines[i];
            if(line.stripLeading().startsWith("```")){
                flush(context,body,paragraph);StringBuilder code=new StringBuilder();
                while(++i<lines.length&&!lines[i].stripLeading().startsWith("```")){if(code.length()>0)code.append('\n');code.append(lines[i]);}
                HorizontalScrollView scroll=new HorizontalScrollView(context);scroll.addView(text(context,code.toString(),true));body.addView(scroll);continue;
            }
            if(i+1<lines.length&&line.contains("|")&&separator(lines[i+1])){
                flush(context,body,paragraph);TableLayout table=new TableLayout(context);table.addView(row(context,line,true));i++;
                while(i+1<lines.length&&lines[i+1].contains("|")&&!lines[i+1].isBlank())table.addView(row(context,lines[++i],false));
                HorizontalScrollView scroll=new HorizontalScrollView(context);scroll.setFillViewport(true);scroll.addView(table);body.addView(scroll);continue;
            }
            if(line.matches("^#{1,6} .+")){flush(context,body,paragraph);TextView heading=text(context,line.replaceFirst("^#{1,6} +",""),false);heading.setTypeface(null,Typeface.BOLD);body.addView(heading);continue;}
            if(paragraph.length()>0)paragraph.append('\n');paragraph.append(line);
        }
        flush(context,body,paragraph);return body;
    }
    static boolean separator(String line){String[] cells=cells(line);return cells.length>0&&Arrays.stream(cells).allMatch(cell->cell.trim().matches(":?-{3,}:?"));}
    private static String[] cells(String line){String value=line.trim();if(value.startsWith("|"))value=value.substring(1);if(value.endsWith("|"))value=value.substring(0,value.length()-1);return value.split("\\|",-1);}
    private static TableRow row(Context context,String line,boolean heading){
        TableRow row=new TableRow(context);for(String cell:cells(line)){TextView view=text(context,cell.trim(),false);view.setMinWidth(UiSheet.dp(context,100));view.setMaxWidth(UiSheet.dp(context,240));view.setPadding(12,10,12,10);if(heading){view.setTypeface(null,Typeface.BOLD);view.setBackgroundColor(0xfff0edf5);}row.addView(view);}return row;
    }
    private static TextView text(Context context,String value,boolean code){TextView view=UiSheet.label(context,"",15,0xff242426);view.setText(code?value:ChatText.assistant(value));view.setTextIsSelectable(true);if(code)view.setTypeface(Typeface.MONOSPACE);return view;}
    private static void flush(Context context,LinearLayout body,StringBuilder paragraph){if(paragraph.length()>0){body.addView(text(context,paragraph.toString(),false));paragraph.setLength(0);}}
    private ReplyView(){}
}

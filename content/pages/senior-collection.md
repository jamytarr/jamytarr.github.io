+++
title = "Senior Collection"
handle = "senior-collection"
date = "2013-09-18T02:53:30Z"
lastmod = "2020-09-14T17:25:13Z"
draft = false
+++
<script src="//www.google.com/jsapi?key=ABQIAAAAzdJTgEbbzKP601jRTXCcHxQxKWmv_H_-S3U8C054ztb_bpeO7RSwyHb8mfLmnPB-bINbr6J0bIeIRg"></script>
<script src="//www.google.com/uds/solutions/slideshow/gfslideshow.js"></script>
<style type="text/css"><!--
#picasaSlideshow {
     height:600px;
      margin-bottom: 40px;
      padding: 5px;
text-align:center;
    }
--></style>
<script>// <![CDATA[
/*
      *  How to make a slideshow with a photo feed using our custom control.
      *  To see the options, go here or click the docs link in the titlebar:
      *  http://www.google.com/uds/solutions/slideshow/index.html
      */

      google.load("feeds", "1");

      function OnLoad() {
          var feed = "http://api.smugmug.com/hack/feed.mg?Type=gallery&Data=12634260_rmCgu&format=rss200&SandBoxed=1&ts=1234a";
          var options = {
              displayTime: 2000,
              transistionTime: 600,
              scaleImages: true,
              fullControlPanel: true,
              thumbnailUrlResolver: myUrlResolver
          };
          var ss = new GFslideShow(feed, "picasaSlideshow", options);
      }

      function myUrlResolver(entry) {
          return entry.mediaGroups[0].contents[4].url;
          // window.alert( entry.guid);//.replace("-Th-4","-L-4");
          //return entry.link + "-M-4.jpg";
      }
      google.setOnLoadCallback(OnLoad);
// ]]></script>
<div style="padding-top: 10px; text-align: center; width: 100%;">
<div id="picasaSlideshow" class="gslideshow">
<div class="feed-loading">Loading...</div>
</div>
</div>

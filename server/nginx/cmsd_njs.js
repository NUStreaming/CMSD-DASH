var querystring = require('querystring');
var fs = require('fs');

var LOGFILE = '/tmp/cmsd.log';  // most other directories wont work due to write permission
var CSVFILE = '/tmp/cmsd.csv';  // most other directories wont work due to write permission
var CONFIGFILE = '/tmp/cmsd_config.json';

function writeLog(msg) {
    var dateTime = new Date().toLocaleString();
    var logLine = ('\n[' + dateTime + '] ' + msg);
    try {
        fs.appendFileSync(LOGFILE, logLine);
    } catch (e) {
        // unable to write to file
    }
}

function writeCsv(metricsObj) {
    // One header and value row for each metricsObj for now
    var csvHeaders = 'timestamp, '
    var timestamp = Math.floor(new Date() / 1000);
    var csvLine = timestamp + ', ';

    for (const key in metricsObj) {
        if (metricsObj.hasOwnProperty(key)) {
            csvHeaders += (key + ', ')
            csvLine += (metricsObj[key] + ', ')
        }
    }

    csvHeaders += '\n'
    csvLine += '\n'

    try {
        fs.appendFileSync(CSVFILE, csvHeaders);
        fs.appendFileSync(CSVFILE, csvLine);
    } catch (e) {
        // unable to write to file
    }
}

function writeConfig(key, value) {
    try {
        var jsonStr = fs.readFileSync(CONFIGFILE);
        var jsonObj = JSON.parse(jsonStr);
        // writeLog('[writeConfig] CONFIGFILE exists');
    } catch (e) {
        // writeLog('[writeConfig] CONFIGFILE not exists, e: ' +  e + '.. creating new jsonObj..');
        var jsonObj = {};
    }

    jsonObj[key] = value;    // update key-value

    try {
        fs.writeFileSync(CONFIGFILE, JSON.stringify(jsonObj));
    } catch (e) {
        // unable to write config
    }
}

function readConfig(key) {
    try {
        var jsonStr = fs.readFileSync(CONFIGFILE);
        var jsonObj = JSON.parse(jsonStr);
        // writeLog('[readConfig] CONFIGFILE exists')
        return jsonObj[key];
    } catch (e) {
        // writeLog('[readConfig] CONFIGFILE not exists, e: ' +  e + '.. returning null..')
        return null;
    }
}

//
// Process query args into Javascript object
//
function processQueryArgs(r) {
    var decodedQueryString = querystring.decode(r.variables.query_string);

    // For dash.js-cmcd version differences
    var cmcdKey;
    if (r.variables.query_string.includes('Common-Media-Client-Data'))
        cmcdKey = 'Common-Media-Client-Data';
    else cmcdKey = 'CMCD';

    var paramsArr = decodedQueryString[cmcdKey].split(',');
    var paramsObj = {};
    for (var i = 0; i < paramsArr.length; i++) {
        if (paramsArr[i].includes('=')) {
            var key = paramsArr[i].split('=')[0];
            var value = paramsArr[i].split('=')[1];
        } 
        else {  // e.g. `bs` key does not have a value in CMCD query arg format
            var key = paramsArr[i];
            var value = 'true';
        }
        paramsObj[key] = value;
    }
    
    return paramsObj;
}

//
// Sample query: http://localhost:8080/cmsd-njs/bufferBasedResponseDelay/media/vod/bbb_30fps_akamai/bbb_30fps.mpd?CMCD=bl%3D21300
//
function getResourceUsingSubrequestBBRD(r) {
    writeLog('');
    writeLog('### getResourceUsingSubrequestBBRD(r) triggered: ' + r.uri);
    // writeLog('.. args: ' + r.variables.args);

    // var dashObjUri = r.uri.split('/cmsd-njs/bufferBasedResponseDelay')[1];
    
    // Different parsing for BBRD compared to BBRC due to use of echo_sleep and echo_exec
    var dashObjUri = r.variables.args.split('/cmsd-njs/bufferBasedResponseDelay')[1].split('?')[0];
    var cmcdArgs = r.variables.args.split(dashObjUri + '?')[1].split(' ')[0];

    writeLog('.. dashObjUri: ' + dashObjUri)
    writeLog('.. cmcdArgs: ' + cmcdArgs)
    writeLog('.. r.variables.bufferBasedDelay: ' + r.variables.bufferBasedDelay)
    
    function done(res) {
        r.headersOut['CMSD-Dynamic'] = ('com.example.dl=' + r.variables.bufferBasedDelay);
        r.headersOut['Access-Control-Expose-Headers'] = ['CMSD-Dynamic'];

        r.return(res.status, res.responseBody);
    }

    // Retrieve requested Dash resource
    r.subrequest(dashObjUri, r.variables.args, done);

    r.finish();
}


//
// Triggered via bufferBasedResponseDelay.echo_sleep setting in nginx.conf
//
// Test queries -
// curl -i http://localhost:8080/cmsd-njs/bufferBasedResponseDelay/media/vod/bbb_30fps_akamai/bbb_30fps.mpd?CMCD=bl%3D21300%2Ccom.example-bmx%3D20000%2Ccom.example-bmn%3D5000%2Cot%3Dv%2Cbr%3D1000%2Cd%3D4000%2Cmtp%3D1000
//
function getBufferBasedDelay(r) {
    var metricsObj = {}

    writeLog('');
    writeLog('### getBufferBasedDelay() triggered!');
    var paramsObj = processQueryArgs(r);

    // If required args are not present in query, skip rate control
    if (!('bl' in paramsObj) || !('com.example-bmx' in paramsObj) || !('com.example-bmn' in paramsObj) || !('ot' in paramsObj) || !('br' in paramsObj) || !('d' in paramsObj) || !('mtp' in paramsObj)) {
        writeLog('Missing one or more required params, ignoring response delay..');
        writeLog(JSON.stringify(paramsObj))
        return 0;   // disables response delay
    }

    // If not video type, skip rate control
    if (paramsObj['ot'] != 'v' && paramsObj['ot'] != 'av') {
        writeLog('- object is not video type, ignoring rate limiting..');
        return 0;   // disables response delay
    }

    var delay;
    var bMin = Number(paramsObj['com.example-bmn']);
    var bMax = Number(paramsObj['com.example-bmx']);
    var bufferLength = Number(paramsObj['bl']);
    
    writeLog('.. bMin = ' + bMin + '.. bMax = ' + bMax + ', bl = ' + bufferLength);
    metricsObj['bufferMin'] = bMin
    metricsObj['bufferMax'] = bMax
    metricsObj['bufferLength'] = bufferLength
    
    var nextBitrate = Number(paramsObj['br']);
    var segDuration = Number(paramsObj['d']) / 1000;    // convert ms to s
    var measuredTput = Number(paramsObj['mtp']);

    writeLog('.. nextBitrate = ' + nextBitrate + ', segDuration = ' + segDuration + ', measuredTput = ' + measuredTput);
    metricsObj['nextBitrate'] = nextBitrate
    metricsObj['segDuration'] = segDuration
    metricsObj['measuredTput'] = measuredTput

    // Retrieve $latestDelay in nginx.conf and compute delay to be applied
    var latestDelay = readConfig('latestDelay')
    if (latestDelay == null)    latestDelay = 0
    var latestDelayTimestamp = readConfig('latestDelayTimestamp')
    if (latestDelayTimestamp == null)    latestDelayTimestamp = 0

    writeLog('.. latestDelay = ' + latestDelay + 's, latestDelayTimestamp = ' + latestDelayTimestamp + 's');
    metricsObj['latestDelay'] = latestDelay
    metricsObj['latestDelayTimestamp'] = latestDelayTimestamp

    // Compute current delay after taking into account time passed
    var currentTimestamp = Math.round(new Date().getTime() / 1000);
    var timePassed = currentTimestamp - latestDelayTimestamp;
    var currentDelay = Math.max(0, (latestDelay - timePassed));

    writeLog('.. currentDelay = ' + currentDelay + 's');
    metricsObj['currentDelay'] = currentDelay

    var expectedSegDownloadTime = (nextBitrate * segDuration) / measuredTput;
    var expectedBufferLengthAfterDelayedDownload =  bufferLength - expectedSegDownloadTime - currentDelay;

    writeLog('.. expectedSegDownloadTime = ' + expectedSegDownloadTime + 's, expectedBufferLengthAfterDelayedDownload = ' + expectedBufferLengthAfterDelayedDownload + 's');
    metricsObj['expectedSegDownloadTime'] = expectedSegDownloadTime
    metricsObj['expectedBufferLengthAfterDelayedDownload'] = expectedBufferLengthAfterDelayedDownload
    
    //
    // Case 1: Client is critical; update $latestDelay in nginx.conf and return delay=0 for this client
    // ($latestDelay will be retrieved by all other non-critical clients)
    //
    if (bufferLength < bMin) {
        writeLog('[case1] Critical client found !!');
        metricsObj['case'] = '1-critical'
        
        // var segSize = nextBitrate * segDuration;
        // var newDelay = segSize / measuredTput;  // computed as expected segment download duration
        var newDelay = expectedSegDownloadTime;

        writeLog('.. newDelay = ' + newDelay + ', currentDelay = ' + currentDelay);
        if (newDelay > currentDelay) {  // update $latestDelay
            writeConfig('latestDelay', newDelay);
            writeConfig('latestDelayTimestamp', currentTimestamp);

            writeLog('.. updated $latestDelay = ' + newDelay);
            metricsObj['delayUpdateToConfig'] = newDelay
            metricsObj['delayTimestampUpdateToConfig'] = currentTimestamp
        }
        else {
            writeLog('.. no update to $latestDelay')
            metricsObj['delayUpdateToConfig'] = -1
        }

        delay = 0   // impt to set this critical client's request to delay=0
    }
    
    //
    // Case 2: Client is in surplus; apply delay
    //
    else if (bufferLength > bMax) {
        writeLog('[case2] Surplus client found, bufferLength: ' + bufferLength);
        metricsObj['case'] = '2-surplus'
        metricsObj['delayUpdateToConfig'] = -1
    // else if (expectedBufferLengthAfterDelayedDownload > bMax) {
    //     writeLog('[case2] Surplus client found, expectedBufferLengthAfterDelayedDownload: ' + expectedBufferLengthAfterDelayedDownload);
        delay = currentDelay;
    }

    // Case 3: All other (normal) clients [bMin, bMax]; apply delay
    else {
        writeLog('[case3] Normal client found, bufferLength: ' + bufferLength);
        metricsObj['case'] = '3-normal'
        metricsObj['delayUpdateToConfig'] = -1
    // else if (expectedBufferLengthAfterDelayedDownload >= bMin) {
    //     writeLog('[case3] Normal client found, expectedBufferLengthAfterDelayedDownload: ' + expectedBufferLengthAfterDelayedDownload);
        // delay = 0.5 * currentDelay;
        
        var bRange = bMax - bMin;
        delay = Math.round((((bufferLength - bMin) / bRange) * currentDelay), 2);
    }
    
    writeLog('Serving current client with delay = ' + delay + ' s!');
    metricsObj['delayForThisReq'] = delay

    writeCsv(metricsObj);
    return delay;
}


// Note: We need to add the function to nginx.conf file too for HTTP access
export default { getResourceUsingSubrequestBBRD, getBufferBasedDelay };


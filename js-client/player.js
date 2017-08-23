
var DigitalFrontierAS = (function () {
    "use strict";

    function Player(composition, baseUrl) {
        // Local, "private" variables
        let context = new window.AudioContext(),
            startTime = null,
            sequences =  null,
            groups = null,
            nextAfter = null,
            sampleCache = {},
            duration = 0.0,
            loadAheadOffset = 0.0,
            compressorNode,
            destination,

            LOAD_AHEAD_TIME_MAX = 10.0,
            LOAD_AHEAD_TIME_MIN = 1.0,

            TRIGGER_BUFFER = context.createBuffer(1, 1, context.sampleRate);
        
        function byTime(a,b) {
            if (a.time < b.time) return -1;
            if (a.time > b.time) return 1;
            return 0;
        }

        this.composition = null;

        this.currentSequence = null;
        this.currentSequenceCounter = 0;
        this.currentSequenceRevolutions = 0;
        
        this.ended = false;
        this.playing = false;
        this.waiting = true;
        this.loadComplete = false;
        //this.readyState = 0; // TODO

        // Event handlers
        //this.onCanPlay = null; // TODO
        this.onEnded = null;
        //this.onPause = null; // TODO
        //this.onPlay = null; // TODO
        this.onPlaying = null;
        this.onWaiting = null;
        
        
        this.onSequenceStart = null;
        this.onSequenceEnd = null;
        this.onGroupStart = null;
        this.onSampleStart = null;
        this.onSampleEnd = null;
        this.onBeat = null;
        
        let player = this;

        if (composition) { this.load(composition, baseUrl); }
        
        // ------------------------------------------------------------------------------------------------
        // Structure and layout
        // ------------------------------------------------------------------------------------------------

        // Put sequences into an object for easy access
        function prepare() {
            sequences = {};
            groups = {};
            nextAfter = [];
            for (let i = 0; i < player.composition.sequences.length; i++) {
                const sequence = player.composition.sequences[i];
                sequences[sequence.name] = sequence;
                if (sequence.nextAfter) {
                    nextAfter.push({sequenceName: sequence.name, time: sequence.nextAfter});
                }
                for (let j = 0; j < sequence.groups.length; j++) {
                    const group = sequence.groups[j];
                    if (!group.name) group.name = "" + j;
                    const key = sequence.name + "." + group.name;
                    groups[key] = group;
                }
            }
            nextAfter = nextAfter.sort(byTime).reverse();
        }

        
        function tearDown() {
            Object.keys(groups).forEach(function (key) {
                const group = groups[key];
                if (group.gainNode) group.gainNode = undefined;
            });
            if (context.state != "closed") context.close();
        }

        
        function layOutSequence(sequence, layout, insertionPoint) {
            if (!layout) layout = [];
            if (!insertionPoint) insertionPoint = 0.0;
            for (let i = 0; i < sequence.groups.length; i++) {
                let group = sequence.groups[i];
                let beat = group.beat;
                if (beat > 0) beat--;
                layout.push({
                    time:     insertionPoint + beat * 60 / sequence.bpm,
                    sequence: sequence,
                    group:    group,
                    sample:   randomElement(group.samples)
                });
            }
            return layout;
        }


        function nextLoop(offset, sequenceName) {
            if (!offset) offset = 0;
            let revolutions = 0;
            let sequence;
            do {
                if (nextAfter.length > 0 && nextAfter[nextAfter.length-1].time <= offset) {
                    sequenceName = nextAfter.pop().sequenceName;
                } else if (!sequenceName) {
                    sequenceName = randomElement(player.composition.start);
                } else {
                    if (!sequence) sequence = sequences[sequenceName];
                    if (!sequence) throw Error("Could not find sequence '" + sequenceName + "'");
                    sequenceName = randomElement(sequence.next);
                }
                if (!sequenceName) return null;
                sequence = sequences[sequenceName];
                if (!sequence) throw Error("Could not find sequence '" + sequenceName + "'");
                
                let nextAfterTime = nextAfter.length > 0 ? nextAfter[nextAfter.length-1].time - offset : Infinity;
                let divisibleBy = sequence.divisibleBy ? sequence.divisibleBy : 1;
                if (nextAfterTime <= 0.0) {
                    revolutions = divisibleBy;
                } else {
                    let sequenceLength = 60 * sequence.numBeats / sequence.bpm;
                    let maxFromNextAfterTime = (Math.floor(nextAfterTime / sequenceLength) + 1) * divisibleBy;
                    revolutions = randomNumber(sequence.minRevolutions, sequence.maxRevolutions, divisibleBy);
                    revolutions = Math.min(revolutions, maxFromNextAfterTime);
                }
            } while (revolutions === 0);
            
            return {
                sequenceName: sequenceName,
                revolutions: revolutions
            };
        }


        function finish() {
            if (context.state != "closed") context.close();
            if (player.onEnded) player.onEnded();
        }


        // ------------------------------------------------------------------------------------------------
        // Utilities
        // ------------------------------------------------------------------------------------------------

        function randomElement (array) {
            if (!array) return null;
            if (array.length === 0) return null;

            let sumProb = 0;
            let noProbCount = 0;
            let randomNumber = Math.random() * 100;

            for (let i = 0; i < array.length; i++) {
                let element = array[i];
                if (element.value === undefined) {
                    element = { value : element };
                    noProbCount++;
                    array[i] = element;
                } else if (element.probability === undefined) {
                    noProbCount++;
                } else {
                    sumProb += element.probability;   
                }
            }

            if (sumProb > 101) throw Error("Sum of probability > 100: " + JSON.stringify(array, null, 2));
            if (sumProb < 99 && noProbCount === 0) throw Error("Sum of probability < 100: " + JSON.stringify(array, null, 2));

            let leftProb = (noProbCount === 0) ? 0.0 : (100.0 - sumProb) / noProbCount;
            sumProb = 0.0;
            for (let i = 0; i < array.length; i++) {
                let element = array[i];
                if (element.probability === undefined) element.probability = leftProb;
                sumProb += element.probability;
                if (randomNumber < sumProb) return element.value;
            }

            return array[array.length-1];
        }


        function randomNumber(fromInclusive, toInclusive, divisibleBy) {
            if (!divisibleBy) divisibleBy = 1;
            return fromInclusive + Math.floor(Math.random() * (toInclusive - fromInclusive + divisibleBy) / divisibleBy) * divisibleBy;
        }



        // ------------------------------------------------------------------------------------------------
        // Public interface
        // ------------------------------------------------------------------------------------------------


        this.load = function (composition, baseUrl) {
            this.composition = composition;
            this.baseUrl = baseUrl;
            this.waiting = true;
            this.loadComplete = false;
            if (!baseUrl) baseUrl = "";
            baseUrl = baseUrl.trim();
            if (baseUrl.length > 0 && !baseUrl.endsWith("/")) baseUrl += "/";

            prepare();
        };

        this.play = function () {
            if (context.state !== "closed") context.close();
            context = new window.AudioContext();
            context.suspend();
            
            compressorNode = context.createDynamicsCompressor();
            compressorNode.connect(context.destination);
            
            destination = compressorNode;
            this.refreshCompressor();
            
            //destination = context.destination;
            
            startTime = context.currentTime;
            scheduleLoop();
        };

        this.stop = function () {
            tearDown();
        };

        this.pause = function () {
            if (context.state != "closed") context.suspend();
        };

        this.resume = function () {
            if (context.state != "closed") context.resume();
        };

        this.currentTime = function () {
            return context.currentTime - startTime;
        };
        
        this.refresh = function (composition) {
            if (!this.composition) return;
            this.refreshCompressor(composition.compressor);
            for (let i = 0; i < composition.sequences.length; i++) {
                const sequence = composition.sequences[i];
                for (let j = 0; j < sequence.groups.length; j++) {
                    const group = sequence.groups[j];
                    let groupName = group.name;
                    if (!groupName) groupName = "" + j;
                    this.refreshGain(sequence.name, groupName, group.gain);
                }
            }
        };
        
        this.refreshGain = function (sequenceName, groupName, gain) {
            const key = sequenceName + "." + groupName;
            const group = groups[key];
            if (group && group.gainNode) {
                if (gain === undefined) {
                    group.gainNode.gain.value = 1;
                } else {
                    group.gainNode.gain.value = gain;
                }
            }
        };
        
        this.refreshCompressor = function (c) {
            if (compressorNode) {
                if (!c) c = this.composition || this.composition.compressor;
                if (c) {
                    compressorNode.threshold.value = (c.threshold === undefined) ? -50 : c.threshold;
                    compressorNode.knee.value = (c.knee === undefined) ? 40 : c.knee;
                    compressorNode.ratio.value = (!c.ratio) ? 12 : c.ratio;
                    compressorNode.attack.value = (c.attack === undefined) ? 0 : c.attack;
                    compressorNode.release.value = (c.release === undefined) ? 0.25 : c.release;
                } else {
                    compressorNode.ratio.value = 1;
                }
            }
        };

        this.schedule = function (offset, fn) {
            if (fn) {
                var source = context.createBufferSource();
                source.buffer = TRIGGER_BUFFER;
                source.connect(destination);
                source.onended = function () { fn(offset); };
                source.start(startTime + offset);
            }
        };
        

        // ------------------------------------------------------------------------------------------------
        // Scheduling
        // ------------------------------------------------------------------------------------------------

        function scheduleLoop(offset, loop, counter) {
            if (!loop) loop = nextLoop(offset);
            if (!loop) {
                finish();
                return;
            }
            if (!counter) counter = 0;
            var sequence = sequences[loop.sequenceName];

            var layout = layOutSequence(sequence);

            if (offset === undefined) {
                // Very first sequence to be played
                offset = 0.0;
                if (layout[0].time < 0.0) offset -= layout[0].time; // In case of "prelude"
            }
            
            var nextOffset = offset + sequence.numBeats * 60.0 / sequence.bpm; // Next sequence starts here
            player.schedule(offset, function () { 
                player.currentSequence = loop.sequenceName;
                player.currentSequenceCounter = counter;
                player.currentSequenceRevolutions = loop.revolutions;
                if (player.onSequenceStart) player.onSequenceStart(offset, loop.sequenceName, counter, loop.revolutions);
            });
            player.schedule(nextOffset, function () { 
                if (player.onSequenceEnd) player.onSequenceEnd(nextOffset, loop.sequenceName, counter, loop.revolutions); 
            });
            scheduleLayout(layout, offset, function () {
                loadAheadOffset = offset;
                if (!player.loadComplete && nextOffset - LOAD_AHEAD_TIME_MAX > 0) {
                    player.schedule(nextOffset - LOAD_AHEAD_TIME_MIN, function() {
                        //console.log("currentTime: " + player.currentTime() + ", loadAheadOffset: " + loadAheadOffset);
                        if (!player.loadComplete && loadAheadOffset - player.currentTime() < LOAD_AHEAD_TIME_MIN) {
                            //console.log("Waiting!");
                            context.suspend();
                            player.waiting = true;
                            if (player.onWaiting) player.onWaiting();
                        }
                    });
                }
                scheduleNextLoop(nextOffset, sequence, loop, counter);
            });
        }

        function scheduleNextLoop(offset, sequence, loop, counter) {
            counter++;
            if (counter == loop.revolutions) {
                loop = nextLoop(offset, sequence.name);
                counter = 0;
            }
            if (!loop) {
                // Nothing more to play
                player.schedule(offset, function () { 
                    player.currentSequence = null;
                    player.currentSequenceCounter = 0;
                    player.currentSequenceRevolutions = 0;
                });
                player.schedule(duration, finish);
                player.loadComplete = true;
                context.resume();
                return;
            } else {
            }
            //var nextOffset = offset + sequence.numBeats * 60.0 / sequence.bpm; // Next sequence starts here
            if (offset - player.currentTime() < LOAD_AHEAD_TIME_MAX) {
                scheduleLoop(offset, loop, counter);
            } else {
                player.schedule(offset - LOAD_AHEAD_TIME_MAX, function () {
                    scheduleLoop(offset, loop, counter);
                });
                context.resume();
                if (player.onPlaying && player.waiting) {
                    player.waiting = false;
                    player.onPlaying();
                }
            }
        }

        function scheduleLayout(layout, offset, ondone) {
            var counter = layout.length;
            function andThen () {
                counter--;
                if (ondone && counter === 0) ondone();
            }
            for (var i = 0; i < layout.length; i++) {
                var element = layout[i];
                scheduleElement(element, offset, andThen);
            }
        }


        function scheduleElement(element, offset, ondone) {
            var sample = element.sample;
            var buffer = sampleCache[sample];
            if (buffer) {
                scheduleBuffer(element.sequence, element.group, sample, buffer, offset + element.time);
                if (ondone) ondone();
            } else {
                loadSample(sample, function (buffer) {
                    scheduleBuffer(element.sequence, element.group, sample, buffer, offset + element.time);
                    if (ondone) ondone();
                });
            }
        }


        function loadSample(sample, ondone) {
            var request = new XMLHttpRequest();
            var url = sample;
            if (player.baseUrl) url = player.baseUrl + url;
            request.open('GET', url, true);
            request.responseType = 'arraybuffer';
            request.onload = function () {
                context.decodeAudioData(request.response, function (buffer) {
                    sampleCache[sample] = buffer;
                    if (ondone) ondone(buffer);
                });
            };
            request.send();
        }

        function getGainNode(sequenceName, groupName) {
            const key = sequenceName + "." + groupName;
            const group = groups[key];
            if (!group.gainNode) {
                group.gainNode = context.createGain();
                group.gainNode.gain.value = (group.gain === undefined) ? 1.0 : group.gain;
                group.gainNode.connect(destination);
            }
            return group.gainNode;
        }

        function scheduleBuffer(sequence, group, sample, buffer, offset) {
            var source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(getGainNode(sequence.name, group.name));
            if (player.onSampleStart) player.schedule(offset, function (offs) { player.onSampleStart(offs, sample, buffer); });
            if (player.onSampleEnd) source.onended = function () { player.onSampleEnd(offset + buffer.duration, sample, buffer); };
            duration = Math.max(duration, offset + buffer.duration);
            source.start(startTime + offset);
        }

    }


    return {
        Player: Player
    };
	
})();


var DigitalFrontierAS = (function () {
    "use strict";

    function Player(song, baseUrl) {
        // Local, "private" variables
        let context = new window.AudioContext(),
            startTime = null,
            sequences =  null,
            groups = null,
            sampleCache = {},
            duration = 0.0,
            compressorNode,
            destination,

            LOAD_AHEAD_TIME = 10.0,

            TRIGGER_BUFFER = context.createBuffer(1, 1, context.sampleRate);

        this.song = null;

        this.currentSequence = null;
        this.currentSequenceCounter = 0;
        this.currentSequenceRevolutions = 0;

        // Event handlers
        this.onStart = null;
        this.onEnd = null;
        this.onSequenceStart = null;
        this.onSequenceEnd = null;
        this.onGroupStart = null;
        this.onSampleStart = null;
        this.onSampleEnd = null;
        this.onBeat = null;

        if (song) { this.load(song, baseUrl); }
        
        // ------------------------------------------------------------------------------------------------
        // Structure and layout
        // ------------------------------------------------------------------------------------------------

        // Put sequences into an object for easy access
        function prepare(player) {
            sequences = {};
            groups = {};
            for (let i = 0; i < player.song.sequences.length; i++) {
                const sequence = player.song.sequences[i];
                sequences[sequence.name] = sequence;
                for (let j = 0; j < sequence.groups.length; j++) {
                    const group = sequence.groups[j];
                    if (!group.name) group.name = "" + j;
                    const key = sequence.name + "." + group.name;
                    groups[key] = group;
                }
            }
        }
        
        function tearDown(player) {
            Object.keys(groups).forEach(function (key) {
                const group = groups[key];
                if (group.gainNode) group.gainNode = undefined;
            });
            if (context.state != "closed") context.close();
        }

        this.layOutSong = function (song) {
            var sequences = this.getSequences(song);

            var layout = [];
            var insertionPoint = 0.0;
            var nextSequenceName = this.randomElement(song.start);
            while (nextSequenceName) {
                var sequence = sequences[nextSequenceName];
                var revolutions = this.randomNumber(sequence.minRevolutions, sequence.maxRevolutions);
                for (var i = 0; i < revolutions; i++) {
                    layout = this.layOutSequence(sequence, layout, insertionPoint);
                    insertionPoint += sequence.numBeats * 60 / sequence.bpm;
                }
                nextSequenceName = this.randomElement(sequence.next);
            }
            return this.normalizeLayout(layout);
            //return layout;
        };

        // Sort samples and make sure the song starts at time = 0.0
        this.normalizeLayout = function (layout) {
            layout = layout.sort(function (a,b) {
                if (a.time < b.time) return -1;
                if (a.time > b.time) return 1;
                return 0;
            });
            if (layout.length > 0) {
                const offset = layout[0].time;
                for (var i = 0; i < layout.length; i++) {
                    layout[i].time -= offset;
                }
            }
            return layout;
        };


        this.layOutSequence = function (sequence, layout, insertionPoint) {
            if (!layout) layout = [];
            if (!insertionPoint) insertionPoint = 0.0;
            for (var i = 0; i < sequence.groups.length; i++) {
                var group = sequence.groups[i];
                layout.push({
                    time: insertionPoint + (group.beat-1) * 60 / sequence.bpm,
                    sequence: sequence,
                    group: group,
                    sample: this.randomElement(group.samples)
                });
            }
            return layout;
        };


        this._nextLoop = function (sequenceName) {
            var revolutions = 0;
            var sequence;
            if (!sequenceName) {
                sequenceName = this.randomElement(this.song.start);
                if (!sequenceName) return null;
                sequence = sequences[sequenceName];
                if (!sequence) return null;
                revolutions = this.randomNumber(sequence.minRevolutions, sequence.maxRevolutions);
            } else {
                sequence = sequences[sequenceName];
            }
            while (revolutions === 0) {
                sequenceName = this.randomElement(sequence.next);
                if (!sequenceName) return null;
                sequence = sequences[sequenceName];
                if (sequence === null) return null;
                revolutions = this.randomNumber(sequence.minRevolutions, sequence.maxRevolutions);
            }
            return {
                sequenceName: sequenceName,
                revolutions: revolutions
            };
        };


        // ------------------------------------------------------------------------------------------------
        // Utilities
        // ------------------------------------------------------------------------------------------------

        this.randomElement = function (array) {
            if (!array) return null;
            if (array.length === 0) return null;
            var index = Math.floor(Math.random() * array.length);
            return array[index];
        };


        this.randomNumber = function (fromInclusive, toInclusive) {
            return fromInclusive + Math.floor(Math.random() * (toInclusive - fromInclusive + 1));
        };



        // ------------------------------------------------------------------------------------------------
        // High level control functions
        // ------------------------------------------------------------------------------------------------


        this.load = function (song, baseUrl) {
            this.song = song;
            this.baseUrl = baseUrl;
            if (!baseUrl) baseUrl = "";
            baseUrl = baseUrl.trim();
            if (baseUrl.length > 0 && !baseUrl.endsWith("/")) baseUrl += "/";

            prepare(this);
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
            this._scheduleLoop();
        };

        this.stop = function () {
            tearDown(this);
        };

        this.pause = function () {
            if (context.state != "closed") context.suspend();
        };

        this.resume = function () {
            if (context.state != "closed") context.resume();
        };

        this._finish = function () {
            if (context.state != "closed") context.close();
            if (this.onEnd) this.onEnd();
        };


        this.currentTime = function () {
            return context.currentTime - startTime;
        };
        
        this.refresh = function (composition) {
            this.refreshCompressor(composition.compressor);
            //refreshGain
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
                    window.console.log("Setting gain for " + key + ": " + gain);
                    group.gainNode.gain.value = gain;
                }
            }
        };
        
        this.refreshCompressor = function (c) {
            if (!c) c = this.song.compressor;
            if (c) {
                compressorNode.threshold.value = (c.threshold === undefined) ? -50 : c.threshold;
                compressorNode.knee.value = (c.knee === undefined) ? 40 : c.knee;
                compressorNode.ratio.value = (!c.ratio) ? 12 : c.ratio;
                compressorNode.attack.value = (c.attack === undefined) ? 0 : c.attack;
                compressorNode.release.value = (c.release === undefined) ? 0.25 : c.release;
            } else {
                compressorNode.ratio.value = 1;
            }
        };


        // ------------------------------------------------------------------------------------------------
        // Scheduling
        // ------------------------------------------------------------------------------------------------

        this._scheduleLoop = function (offset, loop, counter) {
            if (!loop) loop = this._nextLoop();
            if (!loop) {
                this._finish();
                return;
            }
            if (!counter) counter = 0;
            var sequence = sequences[loop.sequenceName];

            var layout = this.layOutSequence(sequence);

            if (offset === undefined) {
                // Very first sequence to be played
                offset = 0.0;
                if (layout[0].time < 0.0) offset -= layout[0].time; // In case of "prelude"
            }

            var nextOffset = offset + sequence.numBeats * 60.0 / sequence.bpm; // Next sequence starts here
            var player = this;
            this.schedule(offset, function () { 
                player.currentSequence = loop.sequenceName;
                player.currentSequenceCounter = counter;
                player.currentSequenceRevolutions = loop.revolutions;
                if (player.onSequenceStart) player.onSequenceStart(offset, loop.sequenceName, counter, loop.revolutions);
            });
            this.schedule(nextOffset, function () { 
                if (player.onSequenceEnd) player.onSequenceEnd(nextOffset, loop.sequenceName, counter, loop.revolutions); 
            });
            this.scheduleLayout(layout, offset, function () {
                player._scheduleNextLoop(nextOffset, sequence, loop, counter);
            });
        };

        this._scheduleNextLoop = function (offset, sequence, loop, counter) {
            counter++;
            if (counter == loop.revolutions) {
                loop = this._nextLoop(sequence.name);
                counter = 0;
            }
            var player = this;
            if (!loop) {
                // Nothing more to play
                this.schedule(offset, function () { 
                    player.currentSequence = null;
                    player.currentSequenceCounter = 0;
                    player.currentSequenceRevolutions = 0;
                });
                this.schedule(duration, function () { player._finish(); });
                context.resume();
                return;
            }
            //var nextOffset = offset + sequence.numBeats * 60.0 / sequence.bpm; // Next sequence starts here
            if (offset - this.currentTime() < LOAD_AHEAD_TIME) {
                this._scheduleLoop(offset, loop, counter);
            } else {
                this.schedule(offset - LOAD_AHEAD_TIME, function () {
                    player._scheduleLoop(offset, loop, counter);
                });
                context.resume();
            }
        };

        this.scheduleLayout = function (layout, offset, ondone) {
            var counter = layout.length;
            function andThen () {
                counter--;
                if (ondone && counter === 0) ondone();
            }
            for (var i = 0; i < layout.length; i++) {
                var element = layout[i];
                this.scheduleElement(element, offset, andThen);
            }
        };


        this.scheduleElement = function (element, offset, ondone) {
            var sample = element.sample;
            var buffer = sampleCache[sample];
            if (buffer) {
                this.scheduleBuffer(element.sequence, element.group, sample, buffer, offset + element.time);
                if (ondone) ondone();
            } else {
                var player = this;
                this.loadSample(sample, function (buffer) {
                    player.scheduleBuffer(element.sequence, element.group, sample, buffer, offset + element.time);
                    if (ondone) ondone();
                });
            }
        };


        this.loadSample = function (sample, ondone) {
            var player = this;
            var request = new XMLHttpRequest();
            var url = sample;
            if (this.baseUrl) url = this.baseUrl + url;
            request.open('GET', url, true);
            request.responseType = 'arraybuffer';
            request.onload = function () {
                context.decodeAudioData(request.response, function (buffer) {
                    sampleCache[sample] = buffer;
                    if (ondone) ondone(buffer);
                });
            };
            request.send();
        };

        function getGainNode(sequenceName, groupName) {
            const key = sequenceName + "." + groupName;
            const group = groups[key];
            if (!group.gainNode) {
                window.console.log("Creating gain node for " + key);
                group.gainNode = context.createGain();
                group.gainNode.gain.value = (group.gain === undefined) ? 1.0 : group.gain;
                group.gainNode.connect(destination);
            }
            return group.gainNode;
        }

        this.scheduleBuffer = function (sequence, group, sample, buffer, offset) {
            var source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(getGainNode(sequence.name, group.name));
            var player = this;
            if (this.onSampleStart) this.schedule(offset, function (offs) { player.onSampleStart(offs, sample, buffer); });
            if (this.onSampleEnd) source.onended = function () { player.onSampleEnd(offset + buffer.duration, sample, buffer); };
            duration = Math.max(duration, offset + buffer.duration);
            source.start(startTime + offset);
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

    }


    return {
        Player: Player
    };
	
})();


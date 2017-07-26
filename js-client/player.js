
var DigitalFrontierAS = (function () {
    "use strict";

    function Player(song, baseUrl) {
        // Local, "private" variables
        let context = new window.AudioContext(),
            startTime = null,
            circles =  null,
            sampleCache = {},
            duration = 0.0,

            local,

            LOAD_AHEAD_TIME = 10.0,

            TRIGGER_BUFFER = context.createBuffer(1, 1, context.sampleRate);


        this.currentCircle = null;
        this.currentCircleCounter = 0;
        this.currentCircleRevolutions = 0;

        // Event handlers
        this.onStart = null;
        this.onEnd = null;
        this.onCircleStart = null;
        this.onCircleEnd = null;
        this.onBagStart = null;
        this.onBagEnd = null;
        this.onSampleStart = null;
        this.onSampleEnd = null;
        this.onBeat = null;

        if (song) { this.load(song, baseUrl); }
        
        this.getLocal = function () { return local; };
        this.setLocal = function (l) { local = l; };
        
        // ------------------------------------------------------------------------------------------------
        // Structure and layout
        // ------------------------------------------------------------------------------------------------

        // Put circles into an object for easy access
        this.getCircles = function getCircles (song) {
            var circles = {};
            for (var i = 0; i < song.circles.length; i++) {
                var circle = song.circles[i];
                circles[circle.name] = circle;
            }
            return circles;
        };

        this.layOutSong = function (song) {
            var circles = this.getCircles(song);

            var layout = [];
            var insertionPoint = 0.0;
            var nextCircleName = this.randomElement(song.start);
            while (nextCircleName) {
                var circle = circles[nextCircleName];
                var revolutions = this.randomNumber(circle.minRevolutions, circle.maxRevolutions);
                for (var i = 0; i < revolutions; i++) {
                    layout = this.layOutCircle(circle, layout, insertionPoint);
                    insertionPoint += circle.numBeats * 60 / circle.bpm;
                }
                nextCircleName = this.randomElement(circle.next);
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


        this.layOutCircle = function (circle, layout, insertionPoint) {
            if (!layout) layout = [];
            if (!insertionPoint) insertionPoint = 0.0;
            for (var i = 0; i < circle.bags.length; i++) {
                var bag = circle.bags[i];
                layout.push({
                    time: insertionPoint + bag.beat * 60 / circle.bpm,
                    sample: this.randomElement(bag.samples),
                    description: bag.description
                });
            }
            return layout;
        };


        this._nextLoop = function (circleName) {
            var revolutions = 0;
            var circle;
            if (!circleName) {
                circleName = this.randomElement(this.song.start);
                if (!circleName) return null;
                circle = circles[circleName];
                if (!circle) return null;
                revolutions = this.randomNumber(circle.minRevolutions, circle.maxRevolutions);
            } else {
                circle = circles[circleName];
            }
            while (revolutions === 0) {
                circleName = this.randomElement(circle.next);
                if (!circleName) return null;
                circle = circles[circleName];
                if (circle === null) return null;
                revolutions = this.randomNumber(circle.minRevolutions, circle.maxRevolutions);
            }
            return {
                circleName: circleName,
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

            circles = this.getCircles(song);
        };

        this.play = function () {
            if (context.state !== "closed") context.close();
            context = new window.AudioContext();
            context.suspend();
            startTime = context.currentTime;
            this._scheduleLoop();
        };

        this.stop = function () {
            if (context.state != "closed") context.close();
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
            var circle = circles[loop.circleName];

            var layout = this.layOutCircle(circle);

            if (offset === undefined) {
                // Very first circle to be played
                offset = 0.0;
                if (layout[0].time < 0.0) offset -= layout[0].time; // In case of "prelude"
            }

            var nextOffset = offset + circle.numBeats * 60.0 / circle.bpm; // Next circle starts here
            var player = this;
            this.schedule(offset, function () { 
                player.currentCircle = loop.circleName;
                player.currentCircleCounter = counter;
                player.currentCircleRevolutions = loop.revolutions;
                if (player.onCircleStart) player.onCircleStart(offset, loop.circleName, counter, loop.revolutions);
            });
            this.schedule(nextOffset, function () { 
                if (player.onCircleEnd) player.onCircleEnd(nextOffset, loop.circleName, counter, loop.revolutions); 
            });
            this.scheduleLayout(layout, offset, function () {
                player._scheduleNextLoop(nextOffset, circle, loop.revolutions, counter);
            });
        };

        this._scheduleNextLoop = function (offset, circle, revolutions, counter) {
            counter++;
            var loop;
            if (counter == revolutions) {
                loop = this._nextLoop(circle.name);
                counter = 0;
            }
            var player = this;
            if (!loop) {
                // Nothing more to play
                this.schedule(offset, function () { 
                    player.currentCircle = null;
                    player.currentCircleCounter = 0;
                    player.currentCircleRevolutions = 0;
                });
                this.schedule(duration, function () { player._finish(); });
                context.resume();
                return;
            }
            var nextOffset = offset + circle.numBeats * 60.0 / circle.bpm; // Next circle starts here
            if (offset - context.currentTime < LOAD_AHEAD_TIME) {
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
                this.scheduleBuffer(sample, buffer, offset + element.time);
                if (ondone) ondone();
            } else {
                var player = this;
                this.loadSample(sample, function (buffer) {
                    player.scheduleBuffer(sample, buffer, offset + element.time);
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


        this.scheduleBuffer = function (sample, buffer, offset) {
            var source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(context.destination);
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
                source.connect(context.destination);
                source.onended = function () { fn(offset); };
                source.start(startTime + offset);
            }
        };

    }


    return {
        Player: Player
    };
	
})();


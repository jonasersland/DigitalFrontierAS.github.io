
function Player(song, baseUrl) {
	this._context = new AudioContext();
	
	this._startTime = null;
	this._circles = null;
	this._sampleCache = {};
	this._duration = 0.0;

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

	this._LOAD_AHEAD_TIME = 10.0;
	this._TRIGGER_BUFFER = this._context.createBuffer(1, 1, this._context.sampleRate);
	
	if (song) this.load(song, baseUrl);

}


// ------------------------------------------------------------------------------------------------
// Structure and layout
// ------------------------------------------------------------------------------------------------

Player.prototype.layOutSong = function (song) {
	var circles = getCircles(song);

	var layout = [];
	var insertionPoint = 0.0;
	var nextCircleName = this.randomElement(song.start);
	while (nextCircleName) {
		circle = circles[nextCircleName];
		var revolutions = this.randomNumber(circle.minRevolutions, circle.maxRevolutions);
		for (var i = 0; i < revolutions; i++) {
			layout = layOutCircle(circle, layout, insertionPoint);
			insertionPoint += circle.numBeats * 60 / circle.bpm;
		}
		nextCircleName = this.randomElement(circle.next);
	}
	return this.normalizeLayout(layout);
	//return layout;
}

// Sort samples and make sure the song starts at time = 0.0
Player.prototype.normalizeLayout = function (layout) {
	layout = layout.sort(function (a,b) {
		if (a.time < b.time) return -1;
		if (a.time > b.time) return 1;
		return 0;
	});
	var offset = layout[0].time;
	for (var i = 0; i < layout.length; i++) {
		layout[i].time -= offset;
	}
	return layout;
}


// Put circles into an object for easy access
Player.prototype.getCircles = function (song) {
	var circles = {};
	for (var i = 0; i < song.circles.length; i++) {
		var circle = song.circles[i];
		circles[circle.name] = circle;
	}
	return circles;
}

Player.prototype.layOutCircle = function (circle, layout, insertionPoint) {
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
}


Player.prototype._nextLoop = function (circleName) {
	var revolutions = 0;
	var circle;
	if (!circleName) {
		circleName = this.randomElement(this.song.start);
		if (!circleName) return null;
		circle = this._circles[circleName];
		if (!circle) return null;
		revolutions = this.randomNumber(circle.minRevolutions, circle.maxRevolutions);
	} else {
		circle = this._circles[circleName];
	}
	while (revolutions === 0) {
		circleName = this.randomElement(circle.next);
		if (!circleName) return null;
		circle = this._circles[circleName];
		if (circle == null) return null;
		revolutions = this.randomNumber(circle.minRevolutions, circle.maxRevolutions);
	}
	return {
		circleName: circleName,
		revolutions: revolutions
	}
}


// ------------------------------------------------------------------------------------------------
// Utilities
// ------------------------------------------------------------------------------------------------

Player.prototype.randomElement = function (array) {
	if (!array) return null;
	if (array.length === 0) return null;
	var index = Math.floor(Math.random() * array.length);
	return array[index];
}


Player.prototype.randomNumber = function (fromInclusive, toInclusive) {
	return fromInclusive + Math.floor(Math.random() * (toInclusive - fromInclusive + 1));
}



// ------------------------------------------------------------------------------------------------
// High level control functions
// ------------------------------------------------------------------------------------------------


Player.prototype.load = function (song, baseUrl) {
	this.song = song;
	this.baseUrl = baseUrl;
	if (!baseUrl) baseUrl = "";
	baseUrl = baseUrl.trim();
	if (baseUrl.length > 0 && !baseUrl.endsWith("/")) baseUrl += "/";
	
	this._circles = this.getCircles(song);
}

Player.prototype.play = function () {
	if (this._context.state !== "closed") this._context.close();
	this._context = new AudioContext();
	this._context.suspend();
	this._startTime = this._context.currentTime;
	this._scheduleLoop();
}

Player.prototype.stop = function () {
	if (this._context.state != "closed") this._context.close();
}

Player.prototype.pause = function () {
	if (this._context.state != "closed") this._context.suspend();
}

Player.prototype.resume = function () {
	if (this._context.state != "closed") this._context.resume();
}

Player.prototype._finish = function () {
	if (this._context.state != "closed") this._context.close();
	if (this.onEnd) this.onEnd();
}


Player.prototype.currentTime = function () {
	return this._context.currentTime - this._startTime;
}


// ------------------------------------------------------------------------------------------------
// Scheduling
// ------------------------------------------------------------------------------------------------

Player.prototype._scheduleLoop = function (offset, loop, counter) {
	if (!loop) loop = this._nextLoop();
	if (!loop) {
		this._finish();
		return;
	}
	if (!counter) counter = 0;
	var circle = this._circles[loop.circleName];

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
		if (player.onCircleEnd) player.onCircleEnd(nextOffset, loop.circleName, counter, loop.revolutions) 
	});
	this.scheduleLayout(layout, offset, function () {
		player._scheduleNextLoop(nextOffset, circle, loop.revolutions, counter);
	});
}

Player.prototype._scheduleNextLoop = function (offset, circle, revolutions, counter) {
	counter++;
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
		this.schedule(this._duration, function () { player._finish() });
		this._context.resume();
		return;
	}
	var nextOffset = offset + circle.numBeats * 60.0 / circle.bpm; // Next circle starts here
	if (offset - player._context.currentTime < player._LOAD_AHEAD_TIME) {
		this._scheduleLoop(offset, loop, counter);
	} else {
		this.schedule(offset - player._LOAD_AHEAD_TIME, function () {
			player._scheduleLoop(offset, loop, counter);
		});
		player._context.resume();
	}
}

Player.prototype.scheduleLayout = function (layout, offset, ondone) {
	var counter = layout.length;
	for (var i = 0; i < layout.length; i++) {
		var element = layout[i];
		this.scheduleElement(element, offset, function () {
			counter--;
			if (ondone && counter === 0) ondone();
		});
	}
}


Player.prototype.scheduleElement = function (element, offset, ondone) {
	var sample = element.sample;
	var buffer = this._sampleCache[sample];
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
}


Player.prototype.loadSample = function (sample, ondone) {
	var player = this;
	var request = new XMLHttpRequest();
	var url = sample;
	if (this.baseUrl) url = this.baseUrl + url;
	request.open('GET', url, true);
	request.responseType = 'arraybuffer';
	request.onload = function () {
		player._context.decodeAudioData(request.response, function (buffer) {
			player._sampleCache[sample] = buffer;
			if (ondone) ondone(buffer);
		});
	}
	request.send();
}


Player.prototype.scheduleBuffer = function (sample, buffer, offset) {
	var source = this._context.createBufferSource();
	source.buffer = buffer;
	source.connect(this._context.destination);
	var player = this;
	if (this.onSampleStart) this.schedule(offset, function (offs) { player.onSampleStart(offs, sample, buffer) });
	if (this.onSampleEnd) source.onended = function () { player.onSampleEnd(offset + buffer.duration, sample, buffer) };
	this._duration = Math.max(this._duration, offset + buffer.duration);
	source.start(this._startTime + offset);
}

Player.prototype.schedule = function (offset, fn) {
	if (fn) {
		var source = this._context.createBufferSource();
		source.buffer = this._TRIGGER_BUFFER;
		source.connect(this._context.destination);
		source.onended = function () { fn(offset) };
		source.start(this._startTime + offset);
	}
}

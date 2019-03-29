// @flow

import { Event, ErrorEvent, Evented } from '../util/evented';

import { extend, pick } from '../util/util';
import loadTileJSON from './load_tilejson';
import { normalizeTileURL as normalizeURL, postTurnstileEvent, postMapLoadEvent } from '../util/mapbox';
import TileBounds from './tile_bounds';
import { ResourceType } from '../util/ajax';
import browser from '../util/browser';
import performance from '../util/performance';

import type {Source} from './source';
import type {OverscaledTileID} from './tile_id';
import type Map from '../ui/map';
import type Dispatcher from '../util/dispatcher';
import type Tile from './tile';
import type {Callback} from '../types/callback';
import type {Cancelable} from '../types/cancelable';
import type {VectorSourceSpecification} from '../style-spec/types';

class VectorTileSource extends Evented implements Source {
    type: 'vector';
    id: string;
    minzoom: number;
    maxzoom: number;
    url: string;
    scheme: string;
    tileSize: number;

    _options: VectorSourceSpecification;
    _collectResourceTiming: boolean;
    dispatcher: Dispatcher;
    map: Map;
    bounds: ?[number, number, number, number];
    tiles: Array<string>;
    tileBounds: TileBounds;
    reparseOverscaled: boolean;
    isTileClipped: boolean;
    _tileJSONRequest: ?Cancelable;

    constructor(id: string, options: VectorSourceSpecification & {collectResourceTiming: boolean}, dispatcher: Dispatcher, eventedParent: Evented) {
        super();
        this.id = id;
        this.dispatcher = dispatcher;

        this.type = 'vector';
        this.minzoom = 0;
        this.maxzoom = 22;
        this.scheme = 'xyz';
        this.tileSize = 512;
        this.reparseOverscaled = true;
        this.isTileClipped = true;

        extend(this, pick(options, ['url', 'scheme', 'tileSize']));
        this._options = extend({ type: 'vector' }, options);

        this._collectResourceTiming = options.collectResourceTiming;

        if (this.tileSize !== 512) {
            throw new Error('vector tile sources must have a tileSize of 512');
        }

        this.setEventedParent(eventedParent);
    }

    load() {
        this.fire(new Event('dataloading', {dataType: 'source'}));
        this._tileJSONRequest = loadTileJSON(this._options, this.map._transformRequest, (err, tileJSON) => {
            this._tileJSONRequest = null;
            if (err) {
                this.fire(new ErrorEvent(err));
            } else if (tileJSON) {
                extend(this, tileJSON);
                if (tileJSON.bounds) this.tileBounds = new TileBounds(tileJSON.bounds, this.minzoom, this.maxzoom);

                postTurnstileEvent(tileJSON.tiles);
                postMapLoadEvent(tileJSON.tiles, this.map._getMapId());

                // `content` is included here to prevent a race condition where `Style#_updateSources` is called
                // before the TileJSON arrives. this makes sure the tiles needed are loaded once TileJSON arrives
                // ref: https://github.com/mapbox/mapbox-gl-js/pull/4347#discussion_r104418088
                this.fire(new Event('data', {dataType: 'source', sourceDataType: 'metadata'}));
                this.fire(new Event('data', {dataType: 'source', sourceDataType: 'content'}));
            }
        });
    }

    hasTile(tileID: OverscaledTileID) {
        return !this.tileBounds || this.tileBounds.contains(tileID.canonical);
    }

    onAdd(map: Map) {
        this.map = map;
        this.load();
    }

    onRemove() {
        if (this._tileJSONRequest) {
            this._tileJSONRequest.cancel();
            this._tileJSONRequest = null;
        }
    }

    serialize() {
        return extend({}, this._options);
    }

    loadTile(tile: Tile, callback: Callback<void>) {
        const start = performance.now();
        const timeline = new performance.Timeline();
        const url = normalizeURL(tile.tileID.canonical.url(this.tiles, this.scheme), this.url);
        const params = {
            request: this.map._transformRequest(url, ResourceType.Tile),
            uid: tile.uid,
            tileID: tile.tileID,
            zoom: tile.tileID.overscaledZ,
            tileSize: this.tileSize * tile.tileID.overscaleFactor(),
            type: this.type,
            source: this.id,
            pixelRatio: browser.devicePixelRatio,
            showCollisionBoxes: this.map.showCollisionBoxes,
        };
        params.request.collectResourceTiming = this._collectResourceTiming;
        let op = '-';

        if (tile.workerID === undefined || tile.state === 'expired') {
            tile.workerID = this.dispatcher.send('loadTile', params, done.bind(this));
            op = 'load';
        } else if (tile.state === 'loading') {
            // schedule tile reloading after it has been loaded
            tile.reloadCallback = callback;
        } else {
            op = 'reload';
            this.dispatcher.send('reloadTile', params, done.bind(this), tile.workerID);
        }

        function done(err, data) {
            if (tile.aborted)
                return callback(null);

            if (err && err.status !== 404) {
                return callback(err);
            }

            if (data && data.resourceTiming)
                tile.resourceTiming = data.resourceTiming;

            if (this.map._refreshExpiredTiles && data) tile.setExpiryData(data);
            tile.loadVectorData(data, this.map.painter);

            tile.perfTiming = {start, op};
            if (data && data.perfTiming && performance.supported) {
                const worker: {[string]: any} = data.perfTiming;
                const main: {[string]: any} = timeline.finish();
                Object.keys(main).forEach(m => {
                    if (Array.isArray(main[m])) {
                        (tile.perfTiming || {})[`m${m}`] = main[m].map(d => d - start);
                    }
                });
                const workerOffset = worker.timeOrigin - main.timeOrigin;
                (tile.perfTiming || {}).workerOffset = workerOffset;
                Object.keys(worker).forEach(m => {
                    if (Array.isArray(worker[m])) {
                        (tile.perfTiming || {})[`w${m}`] = worker[m].map(d => d + workerOffset - start);
                    }
                });
            }

            callback(null);

            if (tile.reloadCallback) {
                this.loadTile(tile, tile.reloadCallback);
                tile.reloadCallback = null;
            }
        }
    }

    abortTile(tile: Tile) {
        this.dispatcher.send('abortTile', { uid: tile.uid, type: this.type, source: this.id }, undefined, tile.workerID);
    }

    unloadTile(tile: Tile) {
        tile.unloadVectorData();
        this.dispatcher.send('removeTile', { uid: tile.uid, type: this.type, source: this.id }, undefined, tile.workerID);
    }

    hasTransition() {
        return false;
    }
}

export default VectorTileSource;

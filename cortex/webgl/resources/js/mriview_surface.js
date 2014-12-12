var mriview = (function(module) {
    var flatscale = 0.25;

    module.Surface = function(ctminfo) {
        this.loaded = $.Deferred();

        this.meshes = [];
        this.pivots = {};
        this.hemis = {};
        this.volume = 0;
        this._pivot = 0;
        this.shaders = {};
        //this.rotation = [ 0, 0, 200 ]; //azimuth, altitude, radius

        this.object = new THREE.Group();
        this.uniforms = THREE.UniformsUtils.merge( [
            THREE.UniformsLib[ "lights" ],
            {
                diffuse:    { type:'v3', value:new THREE.Vector3( .8,.8,.8 )},
                specular:   { type:'v3', value:new THREE.Vector3( .2,.2,.2 )},
                emissive:   { type:'v3', value:new THREE.Vector3( .2,.2,.2 )},
                shininess:  { type:'f',  value:1000},
                specularStrength:{ type:'f',  value:1},

                thickmix:   { type:'f',  value:0.5},
                surfmix:    { type:'f',  value:0},

                //hatch:      { type:'t',  value:0, texture: module.makeHatch() },
                //hatchrep:   { type:'v2', value:new THREE.Vector2(108, 40) },
                hatchAlpha: { type:'f', value:1.},
                hatchColor: { type:'v3', value:new THREE.Vector3( 0,0,0 )},
                overlay:    { type:'t', value:this.blanktex },
                curvAlpha:  { type:'f', value:1.},
                curvScale:  { type:'f', value:.5},
                curvLim:    { type:'f', value:.2},

                screen:     { type:'t', value:this.volumebuf},
                screen_size:{ type:'v2', value:new THREE.Vector2(100, 100)},
            }
        ]);
        
        var loader = new THREE.CTMLoader(false);
        loader.loadParts( ctminfo, function( geometries, materials, json ) {
            geometries[0].computeBoundingBox();
            geometries[1].computeBoundingBox();

            this.flatlims = json.flatlims;
            this.flatoff = [
                Math.max(
                    Math.abs(geometries[0].boundingBox.min.x),
                    Math.abs(geometries[1].boundingBox.max.x)
                ) / 3, Math.min(
                    geometries[0].boundingBox.min.y, 
                    geometries[1].boundingBox.min.y
                )];

            this.names = json.names;
            var gb0 = geometries[0].boundingBox, gb1 = geometries[1].boundingBox;
            var center = [
                ((gb1.max.x - gb0.min.x) / 2) + gb0.min.x,
                (Math.max(gb0.max.y, gb1.max.y) - Math.min(gb0.min.y, gb1.min.y)) / 2 + Math.min(gb0.min.y, gb1.min.y),
                (Math.max(gb0.max.z, gb1.max.z) - Math.min(gb0.min.z, gb1.min.z)) / 2 + Math.min(gb0.min.z, gb1.min.z),
            ];
            this.center = center;
            this.object.position.set(0, -center[1], -center[2]);

            var names = {left:0, right:1};
            var posdata = {left:[], right:[]};
            for (var name in names) {
                var hemi = geometries[names[name]];
                posdata[name].push(hemi.attributes.position);

                //Put attributes in the correct locations for the shader
                if (hemi.attributesKeys.indexOf('wm') != -1) {
                    this.volume = 1;
                    hemi.addAttribute("wmnorm", module.computeNormal(hemi.attributes['wm'], hemi.attributes.index, hemi.offsets) );
                }
                //Rename the actual surfaces to match shader variable names
                for (var i = 0; i < json.names.length; i++ ) {
                    hemi.attributes['mixSurfs'+i] = hemi.attributes[json.names[i]];
                    hemi.addAttribute('mixNorms'+i, module.computeNormal(hemi.attributes[json.names[i]], hemi.attributes.index, hemi.offsets) );
                    posdata[name].push(hemi.attributes['mixSurfs'+i].array);
                    delete hemi.attributes[json.names[i]];
                }
                //Setup flatmap mix
                if (this.flatlims !== undefined) {
                    var flats = this._makeFlat(hemi.attributes.uv.array, json.flatlims, names[name]);
                    hemi.addAttribute('mixSurfs'+json.names.length, new THREE.BufferAttribute(flats.pos, 4));
                    hemi.addAttribute('mixNorms'+json.names.length, new THREE.BufferAttribute(flats.norms, 3));
                    hemi.attributes['mixSurfs'+json.names.length].needsUpdate = true;
                    hemi.attributes['mixNorms'+json.names.length].needsUpdate = true;
                    posdata[name].push(hemi.attributes['mixSurfs'+json.names.length]);
                }

                //Queue blank data attributes for vertexdata
                hemi.addAttribute("data0", new THREE.BufferAttribute(new Float32Array(), 1));
                hemi.addAttribute("data1", new THREE.BufferAttribute(new Float32Array(), 1));
                hemi.addAttribute("data2", new THREE.BufferAttribute(new Float32Array(), 1));
                hemi.addAttribute("data3", new THREE.BufferAttribute(new Float32Array(), 1));

                hemi.dynamic = true;
                var pivots = {back:new THREE.Group(), front:new THREE.Group()};
                pivots.front.add(pivots.back);
                pivots.back.position.y = hemi.boundingBox.min.y - hemi.boundingBox.max.y;
                pivots.front.position.y = hemi.boundingBox.max.y - hemi.boundingBox.min.y + this.flatoff[1];
                this.pivots[name] = pivots;
                this.hemis[name] = hemi;
                this.object.add(pivots.front);
            }
            this.setHalo(1);

            //Add anatomical and flat names
            this.names.unshift("anatomicals");
            if (this.flatlims !== undefined) {
                this.names.push("flat");
            }
            this.loaded.resolve();

        }.bind(this), {useWorker:true});
    };
    THREE.EventDispatcher.prototype.apply(module.Surface.prototype);
    module.Surface.prototype.resize = function(width, height) {
        this.volumebuf = new THREE.WebGLRenderTarget(width, height, {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format:THREE.RGBAFormat,
            stencilBuffer:false,
        });
        this.uniforms.screen.value = this.volumebuf;
        this.uniforms.screen_size.value.set(width, height);
    };
    module.Surface.prototype.init = function(dataview) { 
        this.loaded.done(function() {
            var shaders = [];
            // Halo rendering code, ignore for now
            // if (this.meshes.length > 1) { //setup meshes for halo rendering
            //     for (var i = 0; i < this.meshes.length; i++) {
            //         var shaders = dataview.getShader(Shaders.surface, this.uniforms, {
            //             morphs:this.names.length, volume:1, rois: false, halo: true });
            //         for (var j = 0; j < shaders.length; j++) {
            //             shaders[j].transparent = i != 0;
            //             shaders[j].depthTest = true;
            //             shaders[j].depthWrite = i == 0;
            //             shaders[j].uniforms.thickmix = {type:'f', value: 1 - i / (this.meshes.length-1)};
            //             shaders[j].blending = THREE.CustomBlending;
            //             shaders[j].blendSrc = THREE.OneFactor;
            //             shaders[j].blendDst = THREE.OneFactor;
            //         }
            //         this.preshaders.push(shaders);
            //     }
            //     var shaders = dataview.getShader(Shaders.surface, this.uniforms, {
            //         morphs:this.names.length, volume:1, rois:false, halo:false });
            //     for (var j = 0; j < shaders.length; j++) {
            //         shaders[j].uniforms.thickmix = {type:'f', value:1};
            //         shaders[j].uniforms.dataAlpha = {type:'f', value:0};
            //     }

            //     this.quadshade = dataview.getShader(Shaders.cmap_quad, this.uniforms);
            //     this.quadshade.transparent = true;
            //     this.quadshade.blending = THREE.CustomBlending
            //     this.quadshade.blendSrc = THREE.OneFactor
            //     this.quadshade.blendDst = THREE.OneMinusSrcAlphaFactor
            //     this.quadshade.depthWrite = false;
            // } else {
            if (dataview.vertex) {
                var shaders = dataview.getShader(Shaders.surface_vertex, this.uniforms, {
                            morphs:this.names.length, 
                            volume:this.volume, 
                            rois:  false,
                            halo: false,
                        });
            } else {
                var shaders = dataview.getShader(Shaders.surface_pixel, this.uniforms, {
                            morphs:this.names.length, 
                            volume:this.volume, 
                            rois:  false,
                            halo: false,
                        });
            }
            this.shaders[dataview.uuid] = shaders[0];
        }.bind(this));
    };
    module.Surface.prototype.clearShaders = function() {
        for (var name in this.shaders) {
            this.shaders[name].dispose();
        }
    }
    module.Surface.prototype.prerender = function(idx, renderer, scene, camera) {
        this.dispatchEvent({type:"prerender", idx:idx, renderer:renderer, scene:scene, camera:camera});
    }
    var oldcolor, black = new THREE.Color(0,0,0);
    module.Surface.prototype._prerender_halosurf = function(evt) {
        var idx = evt.idx, renderer = evt.renderer, scene = evt.scene, camera = evt.camera;
        camera.add(scene.fsquad);
        scene.fsquad.material = this.quadshade[idx];
        scene.fsquad.visible = false;
        for (var i = 0; i < this.meshes.length; i++) {
            this.meshes[i].left.material = this.preshaders[i][idx];
            this.meshes[i].right.material = this.preshaders[i][idx];
            this.meshes[i].left.visible = true;
            this.meshes[i].right.visible = true;
        }
        oldcolor = renderer.getClearColor()
        renderer.setClearColor(black, 0);
        //renderer.render(scene, camera);
        renderer.render(scene, camera, this.volumebuf);
        renderer.setClearColor(oldcolor, 1);
        for (var i = 1; i < this.meshes.length; i++) {
            this.meshes[i].left.visible = false;
            this.meshes[i].right.visible = false;
        }
        scene.fsquad.visible = true;
    };

    module.Surface.prototype.apply = function(dataview) {
        for (var i = 0; i < this.meshes.length; i++) {
            this.meshes[i].left.material = this.shaders[dataview.uuid];
            this.meshes[i].right.material = this.shaders[dataview.uuid];
        }
    };

    module.Surface.prototype.setHalo = function(layers) {
        var lmesh, rmesh;
        layers = Math.max(layers, 1);
        for (var i = 0; i < this.meshes.length; i++) {
            this.pivots.left.back.remove(this.meshes[i].left);
            this.pivots.right.back.remove(this.meshes[i].right);
        }
        this.meshes = [];
        for (var i = 0; i < layers; i++) {
            lmesh = this._makeMesh(this.hemis.left);
            rmesh = this._makeMesh(this.hemis.right);
            this.meshes.push({left:lmesh, right:rmesh});
            this.pivots.left.back.add(lmesh);
            this.pivots.right.back.add(rmesh);
        }
    };

    module.Surface.prototype.setMix = function(mix) {
        this.uniforms.surfmix.value = mix;
        var smix = mix * (this.names.length - 1);
        var factor = 1 - Math.abs(smix - (this.names.length-1));
        var clipped = 0 <= factor ? (factor <= 1 ? factor : 1) : 0;
        this.uniforms.specularStrength.value = 1-clipped;
        this.setPivot( 180 * clipped);
    };
    module.Surface.prototype.setPivot = function (val) {
        this._pivot = val;
        var names = {left:1, right:-1}
        if (val > 0) {
            for (var name in names) {
                this.pivots[name].front.rotation.z = 0;
                this.pivots[name].back.rotation.z = val*Math.PI/180 * names[name]/ 2;
            }
        } else {
            for (var name in names) {
                this.pivots[name].back.rotation.z = 0;
                this.pivots[name].front.rotation.z = val*Math.PI/180 * names[name] / 2;
            }
        }
    };
    module.Surface.prototype.setShift = function(val) {
        this.pivots.left.front.position.x = -val;
        this.pivots.right.front.position.x = val;
    };

    module.Surface.prototype._makeMesh = function(geom, shader) {
        //Creates the mesh object given the geometry and shader
        var mesh = new THREE.Mesh(geom, shader);
        mesh.position.y = -this.flatoff[1];
        return mesh;
    };

    module.Surface.prototype._makeFlat = function(uv, flatlims, right) {
        var fmin = flatlims[0], fmax = flatlims[1];
        var flat = new Float32Array(uv.length / 2 * 4);
        var norms = new Float32Array(uv.length / 2 * 3);
        for (var i = 0, il = uv.length / 2; i < il; i++) {
            if (right) {
                flat[i*4+1] = flatscale*uv[i*2] + this.flatoff[1];
                norms[i*3] = 1;
            } else {
                flat[i*4+1] = flatscale*-uv[i*2] + this.flatoff[1];
                norms[i*3] = -1;
            }
            flat[i*4+2] = flatscale*uv[i*2+1];
            uv[i*2]   = (uv[i*2]   + fmin[0]) / fmax[0];
            uv[i*2+1] = (uv[i*2+1] + fmin[1]) / fmax[1];
        }

        return {pos:flat, norms:norms};
    };

    module.SurfDelegate = function(dataview) {
        this.object = new THREE.Group();
        this.update(dataview);
        this._update = this.update.bind(this);
        this._attrib = this.setAttribute.bind(this);
    }
    module.SurfDelegate.prototype.update = function(dataview) {
        if (this.surf !== undefined) {
            this.object.remove(this.surf.object);
            this.surf.clearShaders();
        }
        var subj = dataview.data[0].subject;
        this.surf = subjects[subj];
        this.surf.init(dataview);
        this.object.add(this.surf.object);
    }
    module.SurfDelegate.prototype.setAttribute = function(event) {
        var name = event.name, left = event.value[0], right = event.value[1];
        this.surf.hemis.left.attributes[name] = left;
        this.surf.hemis.right.attributes[name] = right;
    }
    module.SurfDelegate.prototype.setMix = function(mix) {
        return this.surf.setMix(mix);
    }
    module.SurfDelegate.prototype.setPivot = function(pivot) {
        return this.surf.setPivot(mix);
    }
    module.SurfDelegate.prototype.setShift = function(shift) {
        return this.surf.setShift(shift);
    }
    module.SurfDelegate.prototype.apply = function(dataview) {
        return this.surf.apply(dataview);
    }

    return module;
}(mriview || {}));

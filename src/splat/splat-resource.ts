import {
    ContainerResource,
    Entity,
    GraphicsDevice,
    Material,
    Mesh,
    RenderComponent,
    Texture,
    Vec3
} from 'playcanvas';

import { SplatData } from './splat-data';
import { Splat } from './splat';

class SplatResource extends ContainerResource {
    device: GraphicsDevice;
    splatData: SplatData;

    focalPoint = new Vec3();
    entity: Entity;

    renders: RenderComponent[] = [];
    meshes: Mesh[] = [];
    materials: Material[] = [];
    textures: Texture[] = [];

    constructor(device: GraphicsDevice, splatData: SplatData) {
        super();

        this.device = device;
        this.splatData = splatData;
    }

    destroy() {

    }

    instantiateModelEntity(/* options: any */): Entity {
        return null;
    }

    instantiateRenderEntity(options: any): Entity {

        const splat = new Splat(this.device);
        splat.create(this.splatData, options);

        const result = new Entity('ply');
        result.addComponent('render', {
            type: 'asset',
            meshInstances: [splat.meshInstance],
            castShadows: false                  // shadows not supported
        });

        // set custom aabb
        result.render.customAabb = splat.aabb;

        this.focalPoint.copy(splat.focalPoint);

        this.entity = result;

        return result;
    }

    getFocalPoint(): Vec3 {
        return this.entity.getWorldTransform().transformPoint(this.focalPoint);
    }
}

export { SplatResource };
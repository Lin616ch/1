import tempfile,unittest
from pathlib import Path
from PIL import Image
import numpy as np
from prepare_data import order_quad, inspect_one

class ConversionTests(unittest.TestCase):
    def test_permutation_keeps_corners(self):
        pts=[(20,40),(10,10),(10,40),(20,10)]
        q=order_quad(pts)
        self.assertEqual(set(map(tuple,q)),set(pts)); self.assertTrue(np.array_equal(q[0],[10,10]))
    def test_nonconvex_rejected(self):
        with self.assertRaises(ValueError): order_quad([(0,0),(10,0),(0,10),(1,1)])
    def test_zero_extent_rejected(self):
        with self.assertRaises(ValueError): order_quad([(0,0),(0,0),(0,5),(0,5)])
    def inspect(self,body):
        scratch=Path(__file__).resolve().parents[3]/'work'/'conversion_tests'
        scratch.mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=scratch)
        assert Path(self.temp.name).resolve().is_relative_to(scratch.resolve())
        self.addCleanup(self.temp.cleanup)
        p=Path(self.temp.name); image=p/'00001.jpg'; xml=p/'00001.xml'
        Image.new('RGB',(840,712),'white').save(image)
        xml.write_text('<annotation><size><width>840</width><height>712</height></size>'+body+'</annotation>')
        before=(image.read_bytes(),xml.read_bytes())
        res=inspect_one(('train','rgb','00001',image,xml))
        self.assertEqual(before,(image.read_bytes(),xml.read_bytes()))
        return res
    def test_border_coordinates_not_shifted(self):
        r=self.inspect('<object><name>car</name><bndbox><xmin>80</xmin><ymin>90</ymin><xmax>130</xmax><ymax>140</ymax></bndbox></object>')
        self.assertFalse(r['fatal']); q=np.array(list(map(float,r['labels'][0].split()[1:]))).reshape(4,2)
        np.testing.assert_allclose(q[0],[80/840,90/712],atol=1e-8)
    def test_point_is_quarantined(self):
        r=self.inspect('<object><name>car</name><point><x>1</x><y>2</y></point></object>')
        self.assertTrue(r['fatal']); self.assertFalse(r['labels'])
    def test_unknown_not_guessed(self):
        r=self.inspect('<object><name>*</name></object>'); self.assertTrue(r['fatal'])
    def test_empty_preserved(self):
        r=self.inspect(''); self.assertFalse(r['fatal']); self.assertEqual(r['labels'],[])

if __name__=='__main__': unittest.main()
